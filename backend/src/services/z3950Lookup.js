import { spawn } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { Marc } from 'marcjs';

// Library of Congress public Z39.50 target. z3950.loc.gov:7090/Voyager (the
// hostname this task originally named) was retired years ago -- LC's
// current, independently-confirmed target (per ByWater Solutions/Koha and
// the Evergreen ILS wiki's Z39.50 target lists, and LC's own
// loc.gov/z3950/lcserver.html) is lx2.loc.gov:210/LCDB, which goes through
// LC's public Metaproxy. No credentials required. If LC moves targets again,
// update these three constants -- nothing else in this file assumes the
// specific host.
const LOC_HOST = 'lx2.loc.gov';
const LOC_PORT = 210;
const LOC_DATABASE = 'LCDB';

const TIMEOUT_MS = 5000;
const YAZ_CLIENT_BIN = 'yaz-client';

function runYazClientScript(commands, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(YAZ_CLIENT_BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`yaz-client timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });

    child.stdin.write(`${commands.join('\n')}\n`);
    child.stdin.end();
  });
}

function toInternalMarc(record) {
  const fields = record.fields.map((rawField) => {
    const tag = rawField[0];
    if (rawField.length <= 2) {
      return { tag, indicators: null, subfields: null, value: rawField[1] ?? '' };
    }
    const indicators = rawField[1];
    const subfields = [];
    for (let i = 2; i < rawField.length; i += 2) {
      subfields.push({ code: rawField[i], value: rawField[i + 1] });
    }
    return { tag, indicators, subfields };
  });

  return { leader: record.leader, fields };
}

// async function lookupZ3950(isbn) -- searches the LOC Z39.50 target for
// the given ISBN (PQF `@attr 1=7 <isbn>`, the "ISBN use attribute") and
// returns the first matching record parsed into { leader, fields:
// [{ tag, indicators, subfields }] } (control fields carry a plain `value`
// instead, since they have no indicators/subfields), or null if there's no
// hit, yaz-client isn't installed, or the whole thing doesn't finish inside
// the 5s hard timeout.
export async function lookupZ3950(isbn) {
  let dumpDir;
  try {
    dumpDir = await mkdtemp(path.join(tmpdir(), 'autocat-z3950-'));
    const dumpPath = path.join(dumpDir, 'record.mrc');

    const commands = [
      `open tcp:${LOC_HOST}:${LOC_PORT}`,
      `base ${LOC_DATABASE}`,
      'format usmarc',
      `set_marcdump ${dumpPath}`,
      `find @attr 1=7 ${isbn}`,
      'show 1',
      'close',
      'quit',
    ];

    try {
      await runYazClientScript(commands, TIMEOUT_MS);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.warn(
          'Z39.50 lookup skipped: yaz-client is not installed in this environment (apt package "yaz").'
        );
      } else {
        console.warn(`Z39.50 lookup failed for ${isbn}: ${error.message}`);
      }
      return null;
    }

    // set_marcdump only writes a file when show actually retrieved a
    // record, so a missing/empty file reliably means "no hit" without
    // needing to pattern-match yaz-client's stdout text.
    let raw;
    try {
      raw = await readFile(dumpPath);
    } catch {
      return null;
    }
    if (raw.length === 0) {
      return null;
    }

    const record = Marc.parse(raw, 'iso2709');
    return toInternalMarc(record);
  } catch (error) {
    console.warn(`Z39.50 lookup failed for ${isbn}: ${error.message}`);
    return null;
  } finally {
    if (dumpDir) {
      await rm(dumpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function getFields(fields, tag) {
  return fields.filter((field) => field.tag === tag);
}

function getSubfieldValue(field, code) {
  const match = field.subfields?.find((subfield) => subfield.code === code);
  return match ? match.value : null;
}

function cleanPunctuation(text) {
  return text ? text.replace(/[\s/:;,.]+$/, '').trim() || null : null;
}

function parsePageCount(text) {
  const matches = text.match(/\d+/g);
  return matches ? parseInt(matches[matches.length - 1], 10) : null;
}

// Maps our internal { leader, fields } MARC structure to the same flat
// shape isbnLookup.js's other extractors produce, using standard MARC21
// bibliographic tags.
export function extractZ3950Fields(marcRecord) {
  if (!marcRecord) return {};
  const { fields } = marcRecord;

  const field245 = getFields(fields, '245')[0];
  const title = field245 ? cleanPunctuation(getSubfieldValue(field245, 'a')) : null;
  const subtitle = field245 ? cleanPunctuation(getSubfieldValue(field245, 'b')) : null;

  const authors = [];
  const editors = [];
  const illustrators = [];
  const translators = [];

  const mainEntry = [...getFields(fields, '100'), ...getFields(fields, '110'), ...getFields(fields, '111')][0];
  const mainEntryName = mainEntry ? cleanPunctuation(getSubfieldValue(mainEntry, 'a')) : null;
  if (mainEntryName) authors.push(mainEntryName);

  const addedEntries = [...getFields(fields, '700'), ...getFields(fields, '710'), ...getFields(fields, '711')];
  for (const field of addedEntries) {
    const name = cleanPunctuation(getSubfieldValue(field, 'a'));
    if (!name) continue;
    const relator = (getSubfieldValue(field, 'e') || '').toLowerCase();
    if (relator.includes('editor')) editors.push(name);
    else if (relator.includes('illustrat')) illustrators.push(name);
    else if (relator.includes('translat')) translators.push(name);
    else authors.push(name);
  }

  const field250 = getFields(fields, '250')[0];
  const edition = field250 ? cleanPunctuation(getSubfieldValue(field250, 'a')) : null;

  const publisherField = [...getFields(fields, '264'), ...getFields(fields, '260')][0];
  const publisher = publisherField ? cleanPunctuation(getSubfieldValue(publisherField, 'b')) : null;
  const publishDate = publisherField ? cleanPunctuation(getSubfieldValue(publisherField, 'c')) : null;

  const field300 = getFields(fields, '300')[0];
  const rawPages = field300 ? getSubfieldValue(field300, 'a') : null;
  const pages = rawPages ? parsePageCount(rawPages) : null;
  const dimensions = field300 ? cleanPunctuation(getSubfieldValue(field300, 'c')) : null;

  const description =
    getFields(fields, '520')
      .map((field) => getSubfieldValue(field, 'a'))
      .filter(Boolean)
      .join(' ') || null;

  const subjects = [...getFields(fields, '650'), ...getFields(fields, '600'), ...getFields(fields, '610')]
    .map((field) => cleanPunctuation(getSubfieldValue(field, 'a')))
    .filter(Boolean);

  const seriesField = [...getFields(fields, '490'), ...getFields(fields, '830')][0];
  const series = seriesField ? cleanPunctuation(getSubfieldValue(seriesField, 'a')) : null;

  // Existing classification evidence (product spec: "external library
  // classifications are evidence" -- collect them, but the DDC pipeline
  // must never blindly copy them; see ddcClassificationService.js). 082 is
  // an LC-assigned Dewey number when present; 092/090 are LC's own-use
  // call-number fields (092 is the modern tag, 090 legacy) and sometimes
  // carry a Dewey-shaped number too.
  const existingClassifications = [];
  for (const field of getFields(fields, '082')) {
    const number = getSubfieldValue(field, 'a');
    if (number) existingClassifications.push({ source: 'loc_marc_082', number: cleanPunctuation(number), edition: getSubfieldValue(field, '2') });
  }
  for (const field of [...getFields(fields, '092'), ...getFields(fields, '090')]) {
    const number = getSubfieldValue(field, 'a');
    if (number) existingClassifications.push({ source: 'loc_marc_local_call_number', number: cleanPunctuation(number), edition: null });
  }

  return {
    title,
    subtitle,
    authors,
    editors,
    illustrators,
    translators,
    publisher,
    publish_date: publishDate,
    edition,
    pages,
    dimensions,
    description,
    subjects,
    series,
    existing_classifications: existingClassifications,
  };
}
