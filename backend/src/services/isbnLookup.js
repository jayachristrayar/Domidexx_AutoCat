import pool from '../db/index.js';
import { getAvailableOpenAiModel, getOpenAiClientForFallback } from './openaiModelSelector.js';
import { lookupZ3950, extractZ3950Fields } from './z3950Lookup.js';
import { recordUsage } from './usageService.js';
import { webSearchAndScrape } from './webSearchScrape.js';

const CACHE_TTL_INTERVAL = '90 days';
const FETCH_TIMEOUT_MS = 8000;

// Priority order used when sources disagree on a field. z3950 (Library of
// Congress, via Z39.50) goes first: a LOC MARC record is the gold-standard
// cataloguing authority for the fields it actually populates. LibraryThing
// is listed next per the intended long-term priority even though it isn't
// queried yet -- see fetchLibraryThing below. LOC records commonly omit
// things like description/summary text, so lower-priority sources still
// supplement whatever z3950 didn't populate -- mergeField already does this
// generically for every field, no special-casing needed here.
const SOURCE_PRIORITY = ['z3950', 'libraryThing', 'openLibrary', 'googleBooks'];

function normalizeIsbn(isbn) {
  return isbn.replace(/[-\s]/g, '');
}

function isbn10To13(isbn10) {
  const prefixed = `978${isbn10.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(prefixed[i]) * (i % 2 === 0 ? 1 : 3);
  return `${prefixed}${(10 - (sum % 10)) % 10}`;
}

// Only 978-prefixed ISBN-13s have a valid ISBN-10 form (979-prefixed ones
// don't) -- returns null rather than a bogus check digit for those.
function isbn13To10(isbn13) {
  if (!isbn13.startsWith('978')) return null;
  const core = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(core[i]) * (10 - i);
  const check = (11 - (sum % 11)) % 11;
  return `${core}${check === 10 ? 'X' : check}`;
}

// A structured source may only have indexed one form of a book's ISBN --
// product spec item 1 explicitly calls for trying "the exact ISBN, and the
// ISBN-10/ISBN-13 equivalent". Returns the given ISBN first (so an exact
// match is always preferred), then its other form when one exists.
export function isbnVariants(isbn) {
  if (/^\d{13}$/.test(isbn)) {
    const isbn10 = isbn13To10(isbn);
    return isbn10 ? [isbn, isbn10] : [isbn];
  }
  if (/^\d{9}[\dXx]$/.test(isbn)) {
    return [isbn.toUpperCase(), isbn10To13(isbn.toUpperCase())];
  }
  return [isbn];
}

// Tries each ISBN variant against `fn` in order, returning the first
// non-empty result. A variant that throws doesn't stop the attempt --
// only rethrown if every variant fails, so Promise.allSettled at the call
// site still sees a genuine failure when (and only when) nothing worked.
async function tryVariants(variants, fn) {
  let lastError = null;
  for (const variant of variants) {
    try {
      const result = await fn(variant);
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
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
    // Open Library's "languages" entries are refs like "/languages/eng" --
    // the trailing segment is already a MARC-shaped 3-letter code, same
    // format languageCode() in marcPipeline.js expects.
    language: raw.languages?.[0]?.key?.split('/').pop() ?? null,
    table_of_contents: null,
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
    language: raw.language ?? null,
    table_of_contents: null,
  };
}

function extractLibraryThingFields(_raw) {
  return {};
}

const EXTRACTORS = {
  z3950: extractZ3950Fields,
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
  'language',
  'table_of_contents',
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

  // Existing classification evidence (e.g. a Dewey number already on the
  // LOC MARC record): a union across sources, never a single "winning"
  // value like the scalar fields above -- the DDC pipeline treats every
  // entry as supporting evidence to weigh, not a value to pick and trust.
  merged.existing_classifications = SOURCE_PRIORITY.flatMap((source) => extractedBySource[source]?.existing_classifications ?? []);

  merged.sources = {
    z3950: rawBySource.z3950 ?? null,
    libraryThing: rawBySource.libraryThing ?? null,
    openLibrary: rawBySource.openLibrary ?? null,
    googleBooks: rawBySource.googleBooks ?? null,
    // Internal-only quality signal (never sent to the client -- see
    // records.js's toClientResponse): true when the LOC Z39.50 lookup
    // actually supplied data for this record.
    loc_marc: Boolean(rawBySource.z3950),
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
    existing_classifications: [],
    series: null,
    language: null,
    table_of_contents: null,
    conflicts: [],
  };
}

function logApiUsage(userId, model, tokensUsed) {
  return recordUsage({ userId, provider: 'openai', model, requestType: 'ISBN', tokensUsed, status: 'success' });
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

// Deep research runs a second web_search pass, which can easily surface the
// same page again -- dedupe by URL so "Sources found" never lists a
// citation twice.
function dedupeCitations(citations) {
  const seen = new Set();
  return citations.filter((c) => {
    if (!c.url || seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

const STRUCTURED_JSON_SHAPE = `{"isbn": string, "title": string|null, "subtitle": string|null, "authors": string[], "editors": string[], "illustrators": string[], "translators": string[], "publisher": string|null, "publish_date": string|null, "edition": string|null, "physical_description": {"pages": number|null, "dimensions": string|null}, "description": string|null, "subjects": string[], "series": string|null, "language": string|null, "table_of_contents": string|null, "existing_classifications": [{"number": string, "source": string}], "conflicts_found": string|null}`;

// A web_search call genuinely needs more time than a plain completion (the
// model runs multiple real searches before answering), but it must still
// fail well inside any hosting platform's own request timeout rather than
// approach the SDK's unbounded default -- see openaiModelSelector.js's
// CLIENT_TIMEOUT_MS docstring. The final JSON-formatting pass does no
// searching (plain text-to-JSON), so it gets the tighter completion budget.
const WEB_SEARCH_TIMEOUT_MS = 35_000;
const STRUCTURING_TIMEOUT_MS = 20_000;

// This is a normal, always-available research stage (item 1/2/15 of the
// product spec) -- called whenever structured sources (z3950/Open
// Library/Google Books/LibraryThing) either found no title at all, or
// found a title but no real subject/content evidence (description or
// subjects) to classify from. Uses OpenAI's Responses API with the
// built-in web_search tool via the auto-selected model from
// openaiModelSelector.js -- never a hardcoded model name. This is
// deliberately independent of the librarian's selected DDC model
// (NVIDIA/OpenAI, i.e. Model 1/Model 2): it's a backend-supported research
// mechanism, not a DDC-reasoning provider choice, and NVIDIA's chat
// completions API has no equivalent built-in web-search tool to route
// this through even if it were selected.
export async function lookupIsbnWebFallback(isbn, { userId, deep = false } = {}) {
  const pipelineStartedAt = Date.now();
  const model = await getAvailableOpenAiModel();
  if (!model) {
    console.error(`ISBN web research skipped for ${isbn}: no usable OpenAI model available.`);
    return null;
  }

  const client = getOpenAiClientForFallback();
  if (!client) {
    console.error(`ISBN web research skipped for ${isbn}: OPENAI_API_KEY is not configured.`);
    return null;
  }

  // Also search the other ISBN-10/ISBN-13 form (product spec item 1) -- a
  // publisher/library page commonly lists only one form of the number.
  const otherForm = isbnVariants(isbn).find((v) => v !== isbn) ?? null;
  const isbnFormVariation = otherForm ? `, "ISBN ${otherForm}", "${otherForm} book"` : '';
  const deepVariations = deep ? `, "${isbn} author", "${isbn} publisher", "${isbn} catalog", "${isbn} library"` : '';
  let searchResponse;
  const searchStartedAt = Date.now();
  try {
    searchResponse = await client.responses.create(
      {
        model,
        tools: [{ type: 'web_search' }],
        input: `Find comprehensive bibliographic data for the book with ISBN ${isbn}. Search the exact ISBN and variations such as "ISBN ${isbn}", "${isbn} book", "${isbn} title"${isbnFormVariation}${deepVariations} -- do not search by title/author alone. Return: title, subtitle, author(s), editor(s), translator(s), illustrator(s), publisher, publication year, edition, page count, a description or abstract, table of contents if available, subjects/keywords, series, and any existing library classification (e.g. Dewey Decimal / DDC) found on catalog records -- treat any such number as evidence only, not a value to trust blindly. If different sources disagree on any fact, say so explicitly and state which source is most credible and why. Cite the source(s) for each key fact.`,
      },
      { timeout: WEB_SEARCH_TIMEOUT_MS, maxRetries: 0 }
    );
  } catch (error) {
    console.error(`ISBN web research: web_search call failed for ${isbn} after ${Date.now() - searchStartedAt}ms: ${error.message}`);
    return null;
  }
  console.info(`ISBN web research: primary search pass for ${isbn} took ${Date.now() - searchStartedAt}ms`);
  await logApiUsage(userId, model, searchResponse.usage?.total_tokens);

  let searchText = searchResponse.output_text ?? '';
  let citations = extractCitations(searchResponse);

  if (deep) {
    // A genuine second research pass, not a re-ask of the same question --
    // explicitly targets the kind of authoritative sources a librarian
    // would trust most, and is told what the first pass already found so
    // it can confirm/add/conflict rather than repeat it. This is what
    // "aggregate the available evidence" actually means here: real
    // additional search coverage, not two calls that just produce the same
    // single result twice.
    const crossCheckStartedAt = Date.now();
    try {
      const crossCheckResponse = await client.responses.create(
        {
          model,
          tools: [{ type: 'web_search' }],
          input: `Specifically search library catalogs, WorldCat, national/university library records, and publisher or bookseller listings for ISBN ${isbn} to cross-check the research below. Report anything that confirms, adds new detail to, or conflicts with it, and cite sources.\n\nPrevious research:\n${searchText}`,
        },
        { timeout: WEB_SEARCH_TIMEOUT_MS, maxRetries: 0 }
      );
      await logApiUsage(userId, model, crossCheckResponse.usage?.total_tokens);
      searchText = `${searchText}\n\nAdditional cross-check research:\n${crossCheckResponse.output_text ?? ''}`;
      citations = citations.concat(extractCitations(crossCheckResponse));
      console.info(`ISBN web research: deep cross-check pass for ${isbn} took ${Date.now() - crossCheckStartedAt}ms`);
    } catch (error) {
      // Not fatal -- the primary research pass already succeeded; deep mode
      // just doesn't get its extra coverage this time.
      console.warn(`ISBN web research: deep cross-check pass failed for ${isbn} after ${Date.now() - crossCheckStartedAt}ms, continuing with primary research only: ${error.message}`);
    }
  }

  let structuredResponse;
  const structuringStartedAt = Date.now();
  try {
    structuredResponse = await client.responses.create(
      {
        model,
        input: `Convert the following bibliographic research into strict JSON matching exactly this shape (use null for unknown scalar fields and [] for unknown list fields, no extra keys, no commentary, no markdown fences). Resolve any conflicts the research noted by choosing the most credible value; put a short note on what conflicted and why you chose as you did in "conflicts_found" (or null if there were none):
${STRUCTURED_JSON_SHAPE}

ISBN: ${isbn}

Research:
${searchText}`,
      },
      { timeout: STRUCTURING_TIMEOUT_MS, maxRetries: 0 }
    );
  } catch (error) {
    console.error(`ISBN web research: JSON formatting call failed for ${isbn} after ${Date.now() - structuringStartedAt}ms: ${error.message}`);
    return null;
  }
  console.info(`ISBN web research: JSON formatting pass for ${isbn} took ${Date.now() - structuringStartedAt}ms`);
  await logApiUsage(userId, model, structuredResponse.usage?.total_tokens);

  let parsed;
  try {
    parsed = JSON.parse(extractJson(structuredResponse.output_text ?? ''));
  } catch (error) {
    console.error(`ISBN web research: could not parse structured JSON for ${isbn}: ${error.message}`);
    return null;
  }

  if (!parsed.title) {
    console.warn(`ISBN web research: no title found for ${isbn} after research -- treating as not found.`);
    return null;
  }
  if (parsed.conflicts_found) {
    console.info(`ISBN web research: source conflict for ${isbn}: ${parsed.conflicts_found}`);
  }
  console.info(`ISBN web research: full pipeline for ${isbn} (deep=${deep}) took ${Date.now() - pipelineStartedAt}ms`);

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
    language: parsed.language ?? null,
    table_of_contents: parsed.table_of_contents ?? null,
    existing_classifications: Array.isArray(parsed.existing_classifications)
      ? parsed.existing_classifications
          .filter((c) => c?.number)
          .map((c) => ({ source: c.source || 'web_research', number: String(c.number), edition: null }))
      : [],
    conflicts: [],
    // Internal audit detail -- /records/lookup/:isbn strips this down to a
    // bare "provenance": "unverified" before it ever reaches the client.
    // /records/research/:isbn (the chat "check the web" action) is the one
    // place citation URLs/titles ARE deliberately surfaced to the librarian
    // as "Sources found" -- model name never is, either way.
    sources: {
      method: 'web_search',
      model,
      citations: dedupeCitations(citations),
      note: 'verify carefully, not confirmed against a structured bibliographic database',
    },
  };
}

// researchWebForIsbn -- the single entry point for "go find this on the
// open web" (product spec items 4-8: "search the public web using the
// ISBN", "if one source fails, continue researching"). Tries the
// AI-assisted web_search stage first (lookupIsbnWebFallback -- higher
// quality when OPENAI_API_KEY/web_search are available, since the model
// itself reasons over and cross-checks what it finds), and only when that
// stage is unavailable or genuinely finds nothing falls back to a direct,
// key-less search-engine + page-scrape pass (webSearchAndScrape). Neither
// stage failing is allowed to be the single point of failure the product
// spec calls out -- a book with real web presence should surface from
// whichever stage actually has working network/API access right now.
async function researchWebForIsbn(isbn, variants, { userId, deep = false } = {}) {
  const aiResult = await lookupIsbnWebFallback(isbn, { userId, deep });
  if (aiResult) return aiResult;

  console.info(`ISBN lookup: AI web research unavailable or empty for ${isbn}, falling back to direct web search/scrape`);
  try {
    return await webSearchAndScrape(isbn, variants);
  } catch (error) {
    console.error(`ISBN lookup: web search/scrape fallback failed for ${isbn}: ${error.message}`);
    return null;
  }
}

// mergeStructuredWithWeb(structured, web) -- supplements an already-vetted
// structured result with whatever web research additionally found, without
// ever overwriting a field the structured sources already populated
// (structured bibliographic APIs remain the higher-trust source for
// identity fields; web research fills gaps like description/subjects/TOC
// that Open Library/Google Books commonly omit).
export function mergeStructuredWithWeb(structured, web) {
  const merged = { ...structured };
  for (const field of TOP_LEVEL_FIELDS) {
    if (isEmptyValue(merged[field]) && !isEmptyValue(web[field])) {
      merged[field] = web[field];
    }
  }
  const physicalDescription = { ...merged.physical_description };
  for (const field of PHYSICAL_FIELDS) {
    if (isEmptyValue(physicalDescription[field]) && !isEmptyValue(web.physical_description?.[field])) {
      physicalDescription[field] = web.physical_description[field];
    }
  }
  merged.physical_description = physicalDescription;
  merged.sources = {
    ...merged.sources,
    method: 'structured+web',
    web_research: web.sources ?? null,
  };
  merged.partial = isPartial(merged);
  return merged;
}

// A field counts toward "partial" coverage when it's the kind of thing a
// librarian actually wants to see beyond the bare title/author -- used only
// to decide whether the client should say "Partial metadata found" instead
// of showing a full result with no caveat.
const ENRICHMENT_FIELDS = ['publisher', 'publish_date', 'description', 'subjects'];

function isPartial(merged) {
  return ENRICHMENT_FIELDS.filter((field) => isEmptyValue(merged[field])).length >= ENRICHMENT_FIELDS.length - 1;
}

// subscriptionTier is accepted for parity with the caller/session shape but
// no longer gates the web-search fallback -- every configured lookup method
// (structured sources, then AI-assisted web research) is attempted for
// every user before giving up, per the "no source left untried" requirement.
// Kept as a parameter (currently unused) in case a future cost-control
// decision needs it again, rather than changing the call signature twice.
export async function lookupIsbn(rawIsbn, _subscriptionTier, { userId } = {}) {
  const isbn = normalizeIsbn(rawIsbn);
  console.info(`ISBN lookup: received ${isbn}`);

  // A failed/not-found lookup must never become a permanent "successful"
  // cache entry -- excluding source = 'not_found' here means a stale
  // failure recorded before a bug fix (or before a source came back up)
  // can never block a fresh, potentially-successful retry. Only a genuine
  // result (structured or web-research) is ever served from cache.
  const cached = await pool.query(
    `SELECT raw_json FROM isbn_cache
     WHERE isbn = $1 AND fetched_at > now() - interval '${CACHE_TTL_INTERVAL}' AND source != 'not_found'`,
    [isbn]
  );
  if (cached.rows.length > 0) {
    console.info(`ISBN lookup: cache hit for ${isbn}`);
    return cached.rows[0].raw_json;
  }

  // Every structured source is tried against the ISBN-10 AND ISBN-13 form
  // (product spec item 1) -- a catalogue/API commonly indexes a book under
  // only one of the two, and normalizeIsbn above never converts between them.
  const variants = isbnVariants(isbn);
  const sourceCalls = [
    ['z3950', lookupZ3950],
    ['libraryThing', fetchLibraryThing],
    ['openLibrary', fetchOpenLibrary],
    ['googleBooks', fetchGoogleBooks],
  ];

  // Timed and run concurrently (product spec item 2/6/23) -- structured
  // sources never wait on each other, and the total time here is bounded by
  // the single slowest of them, not their sum.
  const structuredStartedAt = Date.now();
  const settled = await Promise.allSettled(sourceCalls.map(([, fn]) => tryVariants(variants, fn)));
  console.info(`ISBN lookup: structured sources for ${isbn} took ${Date.now() - structuredStartedAt}ms (parallel)`);

  const rawBySource = {};
  settled.forEach((result, index) => {
    const [source] = sourceCalls[index];
    if (result.status === 'fulfilled') {
      rawBySource[source] = result.value;
      console.info(`ISBN lookup: ${source} ${result.value ? 'returned data' : 'had no match'} for ${isbn}`);
    } else {
      rawBySource[source] = null;
      console.warn(`ISBN lookup: ${source} failed for ${isbn}: ${result.reason?.message ?? result.reason}`);
    }
  });

  const merged = mergeSources(isbn, rawBySource);
  const hasStructuredTitle = Boolean(merged.title);
  // DDC 23 classification needs actual subject/content evidence (product
  // spec item 4), not just bare bibliographic identity -- a structured hit
  // that found a title but no description/subjects is still too thin to
  // classify confidently. Web research is a normal supplementary stage
  // whenever that's the case, never only a last resort after every
  // structured source has failed outright (item 1/2/15).
  const hasContentEvidence = !isEmptyValue(merged.description) || !isEmptyValue(merged.subjects);
  const needsWebResearch = !hasStructuredTitle || !hasContentEvidence;

  let result;
  let cacheSource;

  if (!needsWebResearch) {
    result = { ...merged, sources: { ...merged.sources, method: 'structured' }, partial: isPartial(merged) };
    cacheSource = 'merged';
    console.info(`ISBN lookup: resolved ${isbn} from structured sources${result.partial ? ' (partial)' : ''}`);
  } else {
    console.info(
      `ISBN lookup: ${hasStructuredTitle ? 'structured sources lack content evidence for' : 'no structured title for'} ${isbn}, running web research`
    );
    const webResult = await researchWebForIsbn(isbn, variants, { userId });
    if (webResult && hasStructuredTitle) {
      // Structured sources already vetted title/author/etc -- web research
      // only supplements whatever they didn't cover (description, subjects,
      // table of contents, ...), it never overwrites an already-known field.
      result = mergeStructuredWithWeb(merged, webResult);
      cacheSource = 'merged';
      console.info(`ISBN lookup: supplemented ${isbn}'s structured result with web research${result.partial ? ' (still partial)' : ''}`);
    } else if (webResult) {
      result = { ...webResult, partial: isPartial(webResult) };
      cacheSource = 'web_search';
      console.info(`ISBN lookup: resolved ${isbn} via web research${result.partial ? ' (partial)' : ''}`);
    } else if (hasStructuredTitle) {
      // Structured gave a real (if thin) result and web research found
      // nothing more to add -- still genuine data, better than nothing.
      result = { ...merged, sources: { ...merged.sources, method: 'structured' }, partial: true };
      cacheSource = 'merged';
      console.warn(`ISBN lookup: web research found nothing to add for ${isbn}, keeping thin structured result`);
    } else {
      result = { ...emptyNormalizedRecord(isbn), not_found: true, sources: { method: 'none' } };
      cacheSource = 'not_found';
      console.warn(`ISBN lookup: all configured sources (structured + web research) exhausted for ${isbn}, returning not_found`);
    }
  }

  // Never cache a not_found result (see the cache-read exclusion above) --
  // writing one would just be dead weight, since it would never be read
  // back anyway.
  if (cacheSource === 'not_found') {
    return result;
  }

  const evidenceFields = TOP_LEVEL_FIELDS.filter((field) => !isEmptyValue(result[field]));
  console.info(`ISBN lookup: ${isbn} resolved via '${result.sources?.method}' with evidence fields [${evidenceFields.join(', ')}]`);

  await pool.query(
    `INSERT INTO isbn_cache (isbn, raw_json, source)
     VALUES ($1, $2, $3)
     ON CONFLICT (isbn) DO UPDATE SET raw_json = EXCLUDED.raw_json, source = EXCLUDED.source, fetched_at = now()`,
    [isbn, JSON.stringify(result), cacheSource]
  );

  return result;
}

// researchIsbnOnWeb -- the backend action behind the "check the web" /
// "check complete web" chat intents (chatService.js's web_lookup /
// deep_web_lookup). Reuses lookupIsbnWebFallback directly rather than
// duplicating any research logic: this is the SAME web-research mechanism
// the normal ISBN lookup uses, just invoked on demand regardless of
// whether structured sources already ran or what they found, because the
// librarian explicitly asked for a fresh web check.
//
// If a structured result is already cached for this ISBN, the web
// research supplements it (never overwrites an already-vetted field) via
// the same mergeStructuredWithWeb policy the main lookup pipeline uses,
// and the merged result replaces the cache entry so a subsequent ordinary
// lookup benefits too.
export async function researchIsbnOnWeb(rawIsbn, { userId, deep = false } = {}) {
  const isbn = normalizeIsbn(rawIsbn);
  console.info(`ISBN chat-triggered ${deep ? 'deep ' : ''}web research for ${isbn}`);

  const webResult = await researchWebForIsbn(isbn, isbnVariants(isbn), { userId, deep });
  if (!webResult) {
    console.warn(`ISBN chat-triggered web research found nothing for ${isbn}`);
    return { isbn, not_found: true };
  }

  const cached = await pool.query(
    `SELECT raw_json FROM isbn_cache WHERE isbn = $1 AND source IN ('merged', 'structured+web')`,
    [isbn]
  );

  let result;
  let cacheSource;
  if (cached.rows.length > 0) {
    result = mergeStructuredWithWeb(cached.rows[0].raw_json, webResult);
    cacheSource = 'structured+web';
  } else {
    result = { ...webResult, partial: isPartial(webResult) };
    cacheSource = 'web_search';
  }

  await pool.query(
    `INSERT INTO isbn_cache (isbn, raw_json, source)
     VALUES ($1, $2, $3)
     ON CONFLICT (isbn) DO UPDATE SET raw_json = EXCLUDED.raw_json, source = EXCLUDED.source, fetched_at = now()`,
    [isbn, JSON.stringify(result), cacheSource]
  );

  return result;
}
