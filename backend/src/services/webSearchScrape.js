// Free, key-less web research fallback for ISBN lookups.
//
// The AI-assisted web_search stage in isbnLookup.js (lookupIsbnWebFallback)
// is a single point of failure: it needs OPENAI_API_KEY configured, an
// OpenAI account entitled to the web_search tool, AND that call to succeed.
// Product spec requirement: "An ISBN lookup must NOT depend on one metadata
// API. If one source fails, the system must continue researching." This
// module is that continuation -- it runs a real public web search (no API
// key required) and scrapes the resulting pages directly, so a book with
// genuine web presence (library catalogues, booksellers, publisher pages)
// still gets found even when the OpenAI research stage is unavailable or
// comes back empty.
//
// Every network call here is individually timed and isolated: one blocked
// search engine or one page that refuses to load never aborts the whole
// lookup -- see fetchWithTimeout/settleAll below, and the "sources rejected
// / accepted" diagnostics that record what happened to each candidate.

const SEARCH_TIMEOUT_MS = 6000;
const PAGE_TIMEOUT_MS = 6000;
const MAX_PAGES_TO_FETCH = 6;
const OVERALL_TIMEOUT_MS = 25_000;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchWithTimeout(url, { timeoutMs, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html,application/xhtml+xml', ...headers },
    });
  } finally {
    clearTimeout(timeout);
  }
}

// Runs every entry of `items` through `fn` concurrently, in isolation --
// one rejection never stops the others, and the caller gets back a plain
// array of { item, value } for whichever succeeded (product spec: "If one
// website blocks scraping: skip that website and continue with other
// sources").
async function settleAll(items, fn) {
  const settled = await Promise.allSettled(items.map((item) => fn(item)));
  return settled.map((result, index) => ({
    item: items[index],
    ok: result.status === 'fulfilled',
    value: result.status === 'fulfilled' ? result.value : null,
    error: result.status === 'rejected' ? result.reason : null,
  }));
}

// -- Search engines -----------------------------------------------------
//
// Both of these are plain HTML result pages, not JSON APIs -- no dev key,
// no quota, works for arbitrary queries. If a given engine changes its
// markup or blocks the request, that single engine's results are simply
// skipped (see searchAllEngines) rather than failing the whole lookup.

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'");
}

function decodeDuckDuckGoRedirect(href) {
  // DDG's html.duckduckgo.com wraps result links as
  // //duckduckgo.com/l/?uddg=<encoded target>&rut=...
  if (href.includes('uddg=')) {
    try {
      const params = new URLSearchParams(href.split('?')[1] ?? '');
      const target = params.get('uddg');
      if (target) return decodeURIComponent(target);
    } catch {
      // fall through to returning href as-is
    }
  }
  return href;
}

async function searchDuckDuckGo(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(url, { timeoutMs: SEARCH_TIMEOUT_MS });
  if (!response.ok) throw new Error(`DuckDuckGo responded with ${response.status}`);
  const html = await response.text();

  const results = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    const href = decodeDuckDuckGoRedirect(decodeHtmlEntities(match[1]));
    const title = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, '').trim());
    if (href.startsWith('http')) results.push({ url: href, title, engine: 'duckduckgo' });
  }
  return results;
}

async function searchBing(query) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(url, { timeoutMs: SEARCH_TIMEOUT_MS });
  if (!response.ok) throw new Error(`Bing responded with ${response.status}`);
  const html = await response.text();

  const results = [];
  const blockRe = /<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/g;
  let match;
  while ((match = blockRe.exec(html)) !== null) {
    const href = decodeHtmlEntities(match[1]);
    const title = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, '').trim());
    if (href.startsWith('http')) results.push({ url: href, title, engine: 'bing' });
  }
  return results;
}

const SEARCH_ENGINES = [
  ['duckduckgo', searchDuckDuckGo],
  ['bing', searchBing],
];

// -- Source priority ------------------------------------------------------
//
// Product spec's "Source priority" list, approximated by hostname pattern
// -- used only to order which pages get fetched/merged first when several
// disagree, never to exclude a source outright (a bookseller listing is
// still real evidence, just lower-priority than a library catalogue).
const DOMAIN_TIERS = [
  { tier: 2, pattern: /(^|\.)(loc\.gov|worldcat\.org|nla\.gov\.au|bl\.uk|bnf\.fr|nationallibrary|nlb\.gov\.sg|indiancultureportal|ndl\.gov\.in|ignca)/i },
  { tier: 3, pattern: /(\.edu(\.[a-z]{2})?|\.ac\.[a-z]{2}|library\.)/i },
  { tier: 4, pattern: /(isbnsearch\.org|isbndb\.com|openlibrary\.org|bookfinder\.com)/i },
  { tier: 5, pattern: /(amazon\.|flipkart\.com|barnesandnoble\.com|abebooks\.|bookdepository\.com|books\.google)/i },
  { tier: 6, pattern: /(goodreads\.com|librarything\.com|thriftbooks\.com|mheducation\.com|mcgraw-?hill)/i },
];

function tierFor(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return 7;
  }
  for (const { tier, pattern } of DOMAIN_TIERS) {
    if (pattern.test(hostname)) return tier;
  }
  return 1; // unrecognized domain -- treated as a possible publisher/other primary source, not excluded
}

// Search results pages / aggregators that are never useful as a scrape
// TARGET (as opposed to a search engine, which we already queried) --
// fetching them wastes a scrape slot on a page with no bibliographic data.
const SKIP_HOST_PATTERN = /(duckduckgo\.com|bing\.com|google\.com\/search|search\.yahoo\.com|facebook\.com|twitter\.com|x\.com|pinterest\.com|youtube\.com)/i;

// -- Page metadata extraction ---------------------------------------------

function firstMatch(html, re) {
  const m = html.match(re);
  return m ? decodeHtmlEntities(m[1].trim()) : null;
}

function allMatches(html, re) {
  const out = [];
  let m;
  const global = new RegExp(re, 'g');
  while ((m = global.exec(html)) !== null) out.push(decodeHtmlEntities(m[1].trim()));
  return out;
}

// extractJsonLd -- pulls out any schema.org Book/Product JSON-LD block.
// Library catalogues and booksellers commonly embed one; when present it's
// by far the most reliable structured data on the page.
function extractJsonLd(html) {
  const blocks = allMatches(html, /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  for (const raw of blocks) {
    try {
      const parsed = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of candidates) {
        const type = String(candidate['@type'] ?? '').toLowerCase();
        if (type.includes('book') || type.includes('product')) return candidate;
      }
    } catch {
      // malformed JSON-LD on the page -- ignore and keep looking
    }
  }
  return null;
}

function jsonLdAuthorNames(jsonLd) {
  if (!jsonLd?.author) return [];
  const authors = Array.isArray(jsonLd.author) ? jsonLd.author : [jsonLd.author];
  return authors.map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean);
}

// A handful of loose "Label: value" heuristics for plain page text -- this
// is a fallback scraper, not a full HTML parser, so these are deliberately
// forgiving rather than exhaustive.
const FIELD_PATTERNS = {
  publisher: /publisher\s*:\s*([A-Z][\w&.,'\- ]{2,60}?)(?:\.\s|\.$|,|;|\s{2,}|$)/i,
  edition: /(\d+(?:st|nd|rd|th)\s+edition)/i,
  publish_date: /\b(19|20)\d{2}\b/,
  pages: /(\d{1,4})\s*pages?\b/i,
  language: /language[:\s]+([A-Za-z]{3,20})/i,
  // Place of publication -- only matched against an EXPLICIT label (never
  // guessed from a bare city name appearing anywhere on the page, which
  // would risk picking up an unrelated address/office location). Covers
  // both a dedicated label ("Place of Publication: London") and the
  // classic library-citation convention "City : Publisher" / "City,
  // Publisher" that most publisher/bookseller pages still print somewhere
  // in their bibliographic details.
  publicationPlaceLabel: /(?:place of publication|published in|city of publication)\s*:?\s*([A-Z][A-Za-z.\- ]{1,40}?)(?:\.\s|\.$|,|;|\s{2,}|$)/i,
  // An explicit "Series:" label -- same conservative approach as
  // publicationPlaceLabel: only an unambiguous, labeled statement, never a
  // guess from a bare phrase that happens to look series-like elsewhere on
  // the page.
  seriesLabel: /series\s*:\s*([A-Z][\w&.,'\- ]{1,80}?)(?:\.\s|\.$|,|;|\s{2,}|$)/i,
};

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Existing-classification evidence (DDC/Dewey numbers already assigned by
// a library catalogue) -- treated purely as supporting evidence for the AI
// step downstream, same as z3950/openLibrary/googleBooks already do in
// isbnLookup.js's merged.existing_classifications.
function extractDdcMentions(text) {
  const matches = [];
  const re = /\b(?:DDC|Dewey)\D{0,12}(\d{2,3}(?:\.\d+)?)\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) matches.push(m[1]);
  return [...new Set(matches)];
}

// Bibliographic-label words that could otherwise be mistaken for a place
// name by the "City : Publisher" citation pattern below (e.g. "Publisher:
// Cambridge University Press" alone, with no place, would otherwise let
// "Publisher" itself get captured as if it were the city).
const PLACE_LABEL_STOPWORDS = new Set([
  'publisher', 'published', 'publication', 'author', 'authors', 'editor', 'editors',
  'isbn', 'edition', 'copyright', 'price', 'format', 'language', 'pages', 'series',
]);

// extractPublicationPlace -- deliberately conservative: only two sources,
// both requiring an explicit, unambiguous signal rather than guessing from
// any city name that happens to appear on the page (a publisher's office
// address, an author bio, a shipping notice, etc. would all produce false
// positives otherwise):
//   1. JSON-LD publisher.address.addressLocality -- schema.org's own
//      structured field for exactly this, when a site bothers to fill it in.
//   2. The classic library-citation convention "City : Publisher Name" (or
//      "City, Publisher Name") -- but ONLY when anchored to the actual
//      extracted publisher name, capped at 3 words with no embedded period
//      (so it can't span across an unrelated preceding sentence), and never
//      when the candidate is itself a bibliographic label like "Publisher"
//      (see PLACE_LABEL_STOPWORDS -- guards against "Publisher: Acme Press"
//      alone, with no real place stated, being misread as one).
// Returns null (never a guess) when neither source has anything -- the
// bracketed AACR2 "[S.l.]" placeholder is the correct, honest fallback
// build260 in marcBuilder.js already uses for that case.
function extractPublicationPlace(jsonLd, bodyText, publisher) {
  const jsonLdLocality = jsonLd?.publisher?.address?.addressLocality;
  if (jsonLdLocality) return String(jsonLdLocality).trim();

  const labeled = bodyText.match(FIELD_PATTERNS.publicationPlaceLabel)?.[1];
  if (labeled) return labeled.trim();

  if (publisher) {
    const escapedPublisher = publisher.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const citationRe = new RegExp(`\\b([A-Z][A-Za-z\\- ]{1,25}?)\\s*[:,]\\s*${escapedPublisher}\\b`, 'g');
    let match;
    while ((match = citationRe.exec(bodyText)) !== null) {
      const candidate = match[1].trim();
      if (!PLACE_LABEL_STOPWORDS.has(candidate.toLowerCase()) && candidate.split(/\s+/).length <= 3) {
        return candidate;
      }
    }
  }

  return null;
}

// `isbnCandidates` (product spec item 5: "search result validation") --
// digits-only ISBN-10/ISBN-13 forms to check for literally in the page's
// text. A publisher/library/bookseller page for a specific book almost
// always prints its own ISBN somewhere (a product spec sheet, a details
// table, a citation block); this is a cheap, reliable, source-agnostic way
// to confirm a fetched page actually is about the requested book rather
// than a same-title different-edition or an unrelated page a search
// engine happened to surface. Returned as `isbn_found_in_page` so callers
// (isbnLookup.js's fetchPageEvidence, webSearchAndScrape's accept/reject
// step) can validate before trusting a page's extracted fields.
export function extractPageMetadata(html, url, { isbnCandidates = [] } = {}) {
  const title = firstMatch(html, /<title[^>]*>([^<]+)<\/title>/i);
  const metaDescription =
    firstMatch(html, /<meta[^>]*name="description"[^>]*content="([^"]*)"/i) ||
    firstMatch(html, /<meta[^>]*property="og:description"[^>]*content="([^"]*)"/i);
  const ogTitle = firstMatch(html, /<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i);

  const jsonLd = extractJsonLd(html);
  const bodyText = stripTags(html).slice(0, 20_000);

  const publisher = jsonLd?.publisher?.name || jsonLd?.publisher || bodyText.match(FIELD_PATTERNS.publisher)?.[1] || null;
  const publicationPlace = extractPublicationPlace(jsonLd, bodyText, publisher ? String(publisher).trim() : null);
  const edition = jsonLd?.bookEdition || bodyText.match(FIELD_PATTERNS.edition)?.[1] || null;
  const publishDate = jsonLd?.datePublished || bodyText.match(FIELD_PATTERNS.publish_date)?.[0] || null;
  const pages = jsonLd?.numberOfPages || bodyText.match(FIELD_PATTERNS.pages)?.[1] || null;
  const language = jsonLd?.inLanguage || bodyText.match(FIELD_PATTERNS.language)?.[1] || null;
  // schema.org's Book type nests series membership under isPartOf (a
  // CreativeWorkSeries) -- checked before the labeled-text fallback, same
  // priority order as publisher/place above.
  const series = jsonLd?.isPartOf?.name || bodyText.match(FIELD_PATTERNS.seriesLabel)?.[1] || null;

  // Digits-only comparison so "978-1-032-76922-6" in the page still matches
  // a plain "9781032769226" candidate, and vice versa.
  const digitsOnlyBody = bodyText.replace(/[^0-9Xx]/g, '');
  const isbnFoundInPage = isbnCandidates.some((candidate) => candidate && digitsOnlyBody.includes(String(candidate).toUpperCase()));

  return {
    url,
    title: jsonLd?.name || ogTitle || title || null,
    subtitle: jsonLd?.alternativeHeadline || null,
    authors: jsonLdAuthorNames(jsonLd),
    publisher: publisher ? String(publisher).trim() : null,
    publication_place: publicationPlace,
    publish_date: publishDate ? String(publishDate).trim() : null,
    edition: edition ? String(edition).trim() : null,
    pages: pages ? Number(String(pages).replace(/\D/g, '')) || null : null,
    language: language ? String(language).trim() : null,
    description: jsonLd?.description || metaDescription || null,
    subjects: jsonLd?.genre ? (Array.isArray(jsonLd.genre) ? jsonLd.genre : [jsonLd.genre]) : [],
    series: series ? String(series).trim() : null,
    existing_classifications: extractDdcMentions(bodyText).map((number) => ({ number, source: 'web_scrape', edition: null })),
    isbn_confirmed: jsonLd?.isbn ? String(jsonLd.isbn) : null,
    isbn_found_in_page: isbnFoundInPage,
  };
}

// -- Composable primitives for agentic tool use ---------------------------
//
// searchWeb/fetchPageMetadata (below) are the SAME search-engine/scrape
// mechanics webSearchAndScrape uses internally, exported individually so
// llm/researchAgent.js can expose them as function-calling tools -- the
// selected AI model (NVIDIA/Own API) decides what to search and which page
// to fetch, one call at a time, rather than this module deciding
// everything up front and handing the model a finished summary. See
// researchAgent.js for how these are wired into that tool-use loop.

// searchWeb(query) -- runs one query against every configured search engine
// in parallel, isolated per engine (one blocked/failing engine never stops
// the others), and returns a deduped, tier-ordered result list. Never
// throws -- an engine failure just means fewer results, not a tool error.
export async function searchWeb(query) {
  const engineResults = await settleAll(SEARCH_ENGINES, async ([name, fn]) => {
    try {
      return await fn(query);
    } catch (error) {
      console.warn(`ISBN web scrape: ${name} search failed for "${query}": ${error.message}`);
      return [];
    }
  });
  const seen = new Set();
  return engineResults
    .flatMap((r) => r.value ?? [])
    .filter((r) => {
      if (SKIP_HOST_PATTERN.test(r.url) || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    })
    .map((r) => ({ title: r.title, url: r.url, tier: tierFor(r.url) }))
    .sort((a, b) => a.tier - b.tier);
}

// fetchPageMetadata(url) -- fetches one URL and extracts its bibliographic
// metadata. Throws (rather than returning null) on any failure -- the
// caller (a tool-executor in researchAgent.js, or webSearchAndScrape below)
// is expected to catch this per-page, never let one bad page abort a whole
// research pass.
export async function fetchPageMetadata(url, { isbnCandidates = [] } = {}) {
  const response = await fetchWithTimeout(url, { timeoutMs: PAGE_TIMEOUT_MS });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) throw new Error(`non-HTML content-type: ${contentType}`);
  const html = await response.text();
  return extractPageMetadata(html, url, { isbnCandidates });
}

// -- Orchestration ----------------------------------------------------------

function buildQueries(isbn, variants) {
  const hyphenated = isbn.length === 13 ? `${isbn.slice(0, 3)}-${isbn.slice(3, 5)}-${isbn.slice(5, 9)}-${isbn.slice(9, 12)}-${isbn.slice(12)}` : null;
  const otherForm = variants.find((v) => v !== isbn) ?? null;
  const queries = new Set([`"${isbn}"`, `"${isbn}" book`]);
  if (hyphenated) queries.add(`"${hyphenated}"`);
  if (otherForm) queries.add(`"${otherForm}"`);
  return [...queries];
}

function isEmptyValue(value) {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

// mergePageFields -- same "first non-empty wins, ordered by trust" merge
// policy isbnLookup.js already uses for structured sources, applied here
// across the scraped pages ordered by DOMAIN_TIERS (product spec item 9:
// "cross-check information across multiple sources"). A page that actually
// had the requested ISBN printed on it (isbn_found_in_page/isbn_confirmed)
// outranks domain tier -- confirmed relevance to THIS book beats a merely
// higher-trust domain that might be about a different edition.
function mergePageFields(pages) {
  const ordered = [...pages].sort((a, b) => {
    const aConfirmed = a.extractedData.isbn_found_in_page ? 0 : 1;
    const bConfirmed = b.extractedData.isbn_found_in_page ? 0 : 1;
    if (aConfirmed !== bConfirmed) return aConfirmed - bConfirmed;
    return a.tier - b.tier;
  });
  const pick = (field) => {
    for (const page of ordered) {
      const value = page.extractedData[field];
      if (!isEmptyValue(value)) return value;
    }
    return null;
  };
  const pickArray = (field) => {
    const values = new Set();
    for (const page of ordered) {
      for (const value of page.extractedData[field] ?? []) values.add(value);
    }
    return [...values];
  };

  return {
    title: pick('title'),
    subtitle: pick('subtitle'),
    authors: pickArray('authors'),
    publisher: pick('publisher'),
    publication_place: pick('publication_place'),
    publish_date: pick('publish_date'),
    edition: pick('edition'),
    pages: pick('pages'),
    language: pick('language'),
    description: pick('description'),
    subjects: pickArray('subjects'),
    series: pick('series'),
    existing_classifications: pages.flatMap((p) => p.extractedData.existing_classifications ?? []),
  };
}

// webSearchAndScrape(isbn, variants) -- the key-less research fallback.
// Returns null when genuinely nothing usable was found (mirrors
// lookupIsbnWebFallback's contract so isbnLookup.js can treat both the
// same way), otherwise a normalized record shaped like every other
// extractor in isbnLookup.js (title/authors/publisher/.../sources).
export async function webSearchAndScrape(isbn, variants = [isbn]) {
  const pipelineStartedAt = Date.now();
  const overallController = new AbortController();
  const overallTimeout = setTimeout(() => overallController.abort(), OVERALL_TIMEOUT_MS);

  try {
    const queries = buildQueries(isbn, variants);
    console.info(`ISBN web scrape: running ${queries.length} search queries for ${isbn}`);

    const perQuery = await settleAll(queries, (query) => searchWeb(query));
    const rawResults = perQuery.flatMap((r) => r.value ?? []);
    console.info(`ISBN web scrape: ${rawResults.length} raw search results for ${isbn}`);

    if (rawResults.length === 0) {
      console.warn(`ISBN web scrape: no search results found for ${isbn} (all search engines failed or blocked)`);
      return null;
    }

    const seen = new Set();
    const candidates = rawResults
      .filter((r) => {
        if (seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      })
      .sort((a, b) => a.tier - b.tier)
      .slice(0, MAX_PAGES_TO_FETCH);

    console.info(`ISBN web scrape: ${candidates.length} candidate pages selected for ${isbn} (from ${seen.size} unique results)`);

    const fetched = await settleAll(candidates, (candidate) => fetchPageMetadata(candidate.url, { isbnCandidates: variants }));

    const accepted = [];
    let rejectedCount = 0;
    fetched.forEach((result) => {
      const data = result.value;
      // Product spec item 5: only accept a page as evidence for THIS ISBN if
      // it actually relates to it -- either the ISBN itself appears on the
      // page (isbn_found_in_page, or a matching isbn_confirmed from JSON-LD),
      // or the page names a different ISBN explicitly (isbn_confirmed set but
      // not matching any variant), in which case it's rejected outright even
      // if it superficially has a title/description -- that's a different
      // book/edition, not supporting evidence for this one.
      const confirmedIsbn = data?.isbn_confirmed ? String(data.isbn_confirmed).replace(/[-\s]/g, '').toUpperCase() : null;
      const confirmedMismatch = confirmedIsbn && !variants.some((v) => v.toUpperCase() === confirmedIsbn);
      if (result.ok && data && (data.title || data.description) && !confirmedMismatch) {
        accepted.push({ tier: result.item.tier, url: result.item.url, resultTitle: result.item.title, extractedData: data });
      } else {
        rejectedCount += 1;
        const reason = confirmedMismatch
          ? `page is for a different ISBN (${confirmedIsbn})`
          : result.error?.message ?? 'no usable metadata on page';
        console.warn(`ISBN web scrape: rejected ${result.item.url} for ${isbn}: ${reason}`);
      }
    });

    console.info(`ISBN web scrape: ${accepted.length} sources accepted, ${rejectedCount} rejected for ${isbn}`);

    if (accepted.length === 0) {
      console.warn(`ISBN web scrape: no page yielded usable metadata for ${isbn}`);
      return null;
    }

    const merged = mergePageFields(accepted);
    if (!merged.title) {
      console.warn(`ISBN web scrape: accepted sources for ${isbn} had no title field, treating as not found`);
      return null;
    }

    console.info(`ISBN web scrape: pipeline for ${isbn} took ${Date.now() - pipelineStartedAt}ms, resolved title="${merged.title}"`);

    return {
      isbn,
      title: merged.title,
      subtitle: merged.subtitle,
      authors: merged.authors,
      editors: [],
      illustrators: [],
      translators: [],
      publisher: merged.publisher,
      publication_place: merged.publication_place,
      publish_date: merged.publish_date,
      edition: merged.edition,
      physical_description: { pages: merged.pages, dimensions: null },
      description: merged.description,
      subjects: merged.subjects,
      series: merged.series,
      language: merged.language,
      table_of_contents: null,
      existing_classifications: merged.existing_classifications,
      conflicts: [],
      sources: {
        method: 'web_scrape',
        queries,
        results_found: rawResults.length,
        pages_fetched: candidates.length,
        pages_accepted: accepted.length,
        pages_rejected: rejectedCount,
        citations: accepted.map((a) => ({ url: a.url, title: a.resultTitle })),
        note: 'verify carefully -- extracted by direct web search/scrape, not confirmed against a structured bibliographic database',
      },
    };
  } finally {
    clearTimeout(overallTimeout);
  }
}
