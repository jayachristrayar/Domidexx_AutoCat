import pool from '../db/index.js';
import { getAvailableOpenAiModel, getOpenAiClientForFallback } from './openaiModelSelector.js';

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

function emptyNormalizedRecord(isbn) {
  return {
    isbn,
    title: null,
    subtitle: null,
    authors: [],
    editors: [],
    illustrators: [],
    translators: [],
    publisher: null,
    publish_date: null,
    edition: null,
    physical_description: { pages: null, dimensions: null },
    description: null,
    subjects: [],
    series: null,
    conflicts: [],
  };
}

async function logApiUsage(userId, model, tokensUsed) {
  try {
    await pool.query('INSERT INTO api_usage (user_id, provider, tokens_used) VALUES ($1, $2, $3)', [
      userId ?? null,
      model,
      tokensUsed ?? null,
    ]);
  } catch (error) {
    console.error(`ISBN web-search fallback: failed to log api_usage: ${error.message}`);
  }
}

function extractCitations(response) {
  const citations = [];
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      for (const annotation of content.annotations ?? []) {
        if (annotation.type === 'url_citation') {
          citations.push({ url: annotation.url, title: annotation.title ?? null });
        }
      }
    }
  }
  return citations;
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

const STRUCTURED_JSON_SHAPE = `{"isbn": string, "title": string|null, "subtitle": string|null, "authors": string[], "editors": string[], "illustrators": string[], "translators": string[], "publisher": string|null, "publish_date": string|null, "edition": string|null, "physical_description": {"pages": number|null, "dimensions": string|null}, "description": string|null, "subjects": string[], "series": string|null}`;

// Only called for paid-tier users, and only when LibraryThing + Open
// Library + Google Books all came back with no usable title. Uses OpenAI's
// Responses API with the built-in web_search tool via the auto-selected
// model from openaiModelSelector.js -- never a hardcoded model name.
export async function lookupIsbnWebFallback(isbn, { userId } = {}) {
  const model = await getAvailableOpenAiModel();
  if (!model) {
    console.error(`ISBN web-search fallback skipped for ${isbn}: no usable OpenAI model available.`);
    return null;
  }

  const client = getOpenAiClientForFallback();
  if (!client) {
    console.error(`ISBN web-search fallback skipped for ${isbn}: OPENAI_API_KEY is not configured.`);
    return null;
  }

  let searchResponse;
  try {
    searchResponse = await client.responses.create({
      model,
      tools: [{ type: 'web_search' }],
      input: `Find bibliographic data for the book with ISBN ${isbn}. Return title, subtitle, authors, publisher, publish date, edition, page count, and a short description. Cite the source(s) you found this from.`,
    });
  } catch (error) {
    console.error(`ISBN web-search fallback: web_search call failed for ${isbn}: ${error.message}`);
    return null;
  }
  await logApiUsage(userId, model, searchResponse.usage?.total_tokens);

  const searchText = searchResponse.output_text ?? '';
  const citations = extractCitations(searchResponse);

  let structuredResponse;
  try {
    structuredResponse = await client.responses.create({
      model,
      input: `Convert the following bibliographic research into strict JSON matching exactly this shape (use null for unknown scalar fields and [] for unknown list fields, no extra keys, no commentary, no markdown fences):
${STRUCTURED_JSON_SHAPE}

ISBN: ${isbn}

Research:
${searchText}`,
    });
  } catch (error) {
    console.error(`ISBN web-search fallback: JSON formatting call failed for ${isbn}: ${error.message}`);
    return null;
  }
  await logApiUsage(userId, model, structuredResponse.usage?.total_tokens);

  let parsed;
  try {
    parsed = JSON.parse(extractJson(structuredResponse.output_text ?? ''));
  } catch (error) {
    console.error(`ISBN web-search fallback: could not parse structured JSON for ${isbn}: ${error.message}`);
    return null;
  }

  if (!parsed.title) {
    return null;
  }

  return {
    isbn,
    title: parsed.title ?? null,
    subtitle: parsed.subtitle ?? null,
    authors: parsed.authors ?? [],
    editors: parsed.editors ?? [],
    illustrators: parsed.illustrators ?? [],
    translators: parsed.translators ?? [],
    publisher: parsed.publisher ?? null,
    publish_date: parsed.publish_date ?? null,
    edition: parsed.edition ?? null,
    physical_description: {
      pages: parsed.physical_description?.pages ?? null,
      dimensions: parsed.physical_description?.dimensions ?? null,
    },
    description: parsed.description ?? null,
    subjects: parsed.subjects ?? [],
    series: parsed.series ?? null,
    conflicts: [],
    // Internal audit tag only -- the /records/lookup/:isbn route strips this
    // down to a bare "provenance": "unverified" before it ever reaches the
    // client. citations/model never leave the server.
    sources: {
      method: 'web_search',
      model,
      citations,
      note: 'verify carefully, not confirmed against a structured bibliographic database',
    },
  };
}

export async function lookupIsbn(rawIsbn, subscriptionTier, { userId } = {}) {
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
  const hasStructuredTitle = Boolean(merged.title);

  let result;
  let cacheSource;

  if (hasStructuredTitle) {
    result = { ...merged, sources: { ...merged.sources, method: 'structured' } };
    cacheSource = 'merged';
  } else if (subscriptionTier === 'paid') {
    const webResult = await lookupIsbnWebFallback(isbn, { userId });
    if (webResult) {
      result = webResult;
      cacheSource = 'web_search';
    } else {
      result = { ...emptyNormalizedRecord(isbn), not_found: true, sources: { method: 'none' } };
      cacheSource = 'not_found';
    }
  } else {
    result = { ...emptyNormalizedRecord(isbn), not_found: true, sources: { method: 'none' } };
    cacheSource = 'not_found';
  }

  await pool.query(
    `INSERT INTO isbn_cache (isbn, raw_json, source)
     VALUES ($1, $2, $3)
     ON CONFLICT (isbn) DO UPDATE SET raw_json = EXCLUDED.raw_json, source = EXCLUDED.source, fetched_at = now()`,
    [isbn, JSON.stringify(result), cacheSource]
  );

  return result;
}
