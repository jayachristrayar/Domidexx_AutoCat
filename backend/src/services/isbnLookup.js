import pool from '../db/index.js';

const CACHE_TTL_INTERVAL = '90 days';
const FETCH_TIMEOUT_MS = 8000;

// Priority order used when sources disagree on a field. LibraryThing is
// listed first per the intended long-term priority even though it isn't
// queried yet -- see fetchLibraryThing below.
const SOURCE_PRIORITY = ['libraryThing', 'openLibrary', 'googleBooks'];

function normalizeIsbn(isbn) {
  return isbn.replace(/[-\s]/g, '');
}

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOpenLibrary(isbn) {
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Open Library responded with ${response.status}`);
  }
  const body = await response.json();
  return body[`ISBN:${isbn}`] ?? null;
}

async function fetchGoogleBooks(isbn) {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}${key ? `&key=${key}` : ''}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Google Books responded with ${response.status}`);
  }
  const body = await response.json();
  return body.items?.[0]?.volumeInfo ?? null;
}

// TODO: wire up real LibraryThing metadata once access is sorted out.
//
// What was checked: thingISBN (http://www.librarything.com/api/thingISBN/<isbn>,
// no dev key required) only returns a list of related-edition ISBNs from the
// same work -- it carries no title/author/publisher/etc, so it can't
// populate this record on its own. The LibraryThing web services that DO
// return bibliographic/Common Knowledge data (e.g. librarything.ck.getwork)
// require a LibraryThing developer key (LIBRARYTHING_API_KEY, obtained via
// https://www.librarything.com/services/keys.php) AND are licensed for
// non-commercial use only by default -- commercial use requires separate
// written permission from LibraryThing per
// https://www.librarything.com/developer/terms. Since AutoCat is a
// commercial product, that permission needs to be sorted out before this
// source goes live. Until then this always resolves to null and the merge
// simply skips it.
async function fetchLibraryThing(_isbn) {
  if (!process.env.LIBRARYTHING_API_KEY) {
    return null;
  }
  return null;
}

function extractOpenLibraryFields(raw) {
  if (!raw) return {};

  const contributions = raw.contributions ?? [];
  const byRole = (role) =>
    contributions
      .filter((entry) => new RegExp(`\\(${role}\\)`, 'i').test(entry))
      .map((entry) => entry.replace(new RegExp(`\\s*\\(${role}\\)`, 'i'), '').trim());

  return {
    title: raw.title ?? null,
    subtitle: raw.subtitle ?? null,
    authors: (raw.authors ?? []).map((author) => author.name),
    editors: byRole('Editor'),
    illustrators: byRole('Illustrator'),
    translators: byRole('Translator'),
    publisher: raw.publishers?.[0]?.name ?? null,
    publish_date: raw.publish_date ?? null,
    edition: raw.edition_name ?? null,
    pages: raw.number_of_pages ?? null,
    dimensions: raw.physical_dimensions ?? null,
    description: typeof raw.notes === 'string' ? raw.notes : (raw.notes?.value ?? null),
    subjects: (raw.subjects ?? []).map((subject) => subject.name),
    series: raw.series?.[0] ?? null,
  };
}

function extractGoogleBooksFields(raw) {
  if (!raw) return {};

  const dims = raw.dimensions;
  const dimensionsStr = dims
    ? [dims.height, dims.width, dims.thickness].filter(Boolean).join(' x ') || null
    : null;

  return {
    title: raw.title ?? null,
    subtitle: raw.subtitle ?? null,
    authors: raw.authors ?? [],
    editors: [],
    illustrators: [],
    translators: [],
    publisher: raw.publisher ?? null,
    publish_date: raw.publishedDate ?? null,
    edition: null,
    pages: raw.pageCount ?? null,
    dimensions: dimensionsStr,
    description: raw.description ?? null,
    subjects: raw.categories ?? [],
    series: null,
  };
}

function extractLibraryThingFields(_raw) {
  return {};
}

const EXTRACTORS = {
  libraryThing: extractLibraryThingFields,
  openLibrary: extractOpenLibraryFields,
  googleBooks: extractGoogleBooksFields,
};

function isEmptyValue(value) {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function valuesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeField(fieldName, extractedBySource) {
  const present = SOURCE_PRIORITY.map((source) => ({
    source,
    value: extractedBySource[source]?.[fieldName],
  })).filter(({ value }) => !isEmptyValue(value));

  if (present.length === 0) {
    return { value: null, conflict: null };
  }

  const [primary, ...rest] = present;
  const differing = rest.filter(({ value }) => !valuesEqual(value, primary.value));

  const conflict =
    differing.length > 0 ? { field: fieldName, values: [primary, ...differing] } : null;

  return { value: primary.value, conflict };
}

const TOP_LEVEL_FIELDS = [
  'title',
  'subtitle',
  'authors',
  'editors',
  'illustrators',
  'translators',
  'publisher',
  'publish_date',
  'edition',
  'description',
  'subjects',
  'series',
];

const ARRAY_FIELDS = new Set(['authors', 'editors', 'illustrators', 'translators', 'subjects']);

const PHYSICAL_FIELDS = ['pages', 'dimensions'];

export function mergeSources(isbn, rawBySource) {
  const extractedBySource = Object.fromEntries(
    SOURCE_PRIORITY.map((source) => [source, EXTRACTORS[source](rawBySource[source])])
  );

  const merged = { isbn };
  const conflicts = [];

  for (const field of TOP_LEVEL_FIELDS) {
    const { value, conflict } = mergeField(field, extractedBySource);
    merged[field] = value === null && ARRAY_FIELDS.has(field) ? [] : value;
    if (conflict) conflicts.push(conflict);
  }

  const physicalDescription = {};
  for (const field of PHYSICAL_FIELDS) {
    const { value, conflict } = mergeField(field, extractedBySource);
    physicalDescription[field] = value;
    if (conflict) conflicts.push({ ...conflict, field: `physical_description.${field}` });
  }
  merged.physical_description = physicalDescription;

  merged.sources = {
    libraryThing: rawBySource.libraryThing ?? null,
    openLibrary: rawBySource.openLibrary ?? null,
    googleBooks: rawBySource.googleBooks ?? null,
  };
  merged.conflicts = conflicts;

  return merged;
}

export async function lookupIsbn(rawIsbn) {
  const isbn = normalizeIsbn(rawIsbn);

  const cached = await pool.query(
    `SELECT raw_json FROM isbn_cache WHERE isbn = $1 AND fetched_at > now() - interval '${CACHE_TTL_INTERVAL}'`,
    [isbn]
  );
  if (cached.rows.length > 0) {
    return cached.rows[0].raw_json;
  }

  const sourceCalls = [
    ['libraryThing', fetchLibraryThing],
    ['openLibrary', fetchOpenLibrary],
    ['googleBooks', fetchGoogleBooks],
  ];

  const settled = await Promise.allSettled(sourceCalls.map(([, fn]) => fn(isbn)));

  const rawBySource = {};
  settled.forEach((result, index) => {
    const [source] = sourceCalls[index];
    if (result.status === 'fulfilled') {
      rawBySource[source] = result.value;
    } else {
      rawBySource[source] = null;
      console.warn(`ISBN lookup: ${source} failed for ${isbn}: ${result.reason?.message ?? result.reason}`);
    }
  });

  const merged = mergeSources(isbn, rawBySource);

  await pool.query(
    `INSERT INTO isbn_cache (isbn, raw_json, source)
     VALUES ($1, $2, 'merged')
     ON CONFLICT (isbn) DO UPDATE SET raw_json = EXCLUDED.raw_json, source = EXCLUDED.source, fetched_at = now()`,
    [isbn, JSON.stringify(merged)]
  );

  return merged;
}
