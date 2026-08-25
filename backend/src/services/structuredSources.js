// Plain structured bibliographic API lookups (Open Library, Google Books) --
// factored out of isbnLookup.js so both the model-agnostic structured-source
// pass in isbnLookup.js AND the agentic research tools in
// llm/researchAgent.js (a "lookup_structured_apis" tool the selected AI
// model can call itself) can use the exact same fetchers without importing
// from each other and creating a circular dependency between isbnLookup.js
// and llm/researchAgent.js.

export const FETCH_TIMEOUT_MS = 8000;

export async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchOpenLibrary(isbn) {
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Open Library responded with ${response.status}`);
  }
  const body = await response.json();
  const edition = body[`ISBN:${isbn}`] ?? null;
  if (!edition) return null;

  // Open Library's edition-level jscmd=data response (above) never carries an
  // actual book description/synopsis -- only bibliographic notes ("Previous
  // ed.: 1992. Includes bibliographical references."), which is a completely
  // different thing. The real description, when Open Library has one, lives
  // on the WORK record, one level up from the edition. Fetched here as
  // genuine supplementary evidence (real page fetches, not a guess) -- purely
  // best-effort: any failure here must never break the edition lookup that
  // already succeeded above.
  const description = await fetchOpenLibraryWorkDescription(isbn).catch((error) => {
    console.warn(`Open Library: work-level description lookup failed for ${isbn}: ${error.message}`);
    return null;
  });
  return description ? { ...edition, description } : edition;
}

async function fetchOpenLibraryWorkDescription(isbn) {
  const editionResponse = await fetchWithTimeout(`https://openlibrary.org/isbn/${isbn}.json`);
  if (!editionResponse.ok) return null;
  const editionData = await editionResponse.json();
  const workKey = editionData?.works?.[0]?.key;
  if (!workKey) return null;

  const workResponse = await fetchWithTimeout(`https://openlibrary.org${workKey}.json`);
  if (!workResponse.ok) return null;
  const workData = await workResponse.json();
  const raw = workData?.description;
  const value = typeof raw === 'string' ? raw : (raw?.value ?? null);
  return value ? String(value).trim() || null : null;
}

export async function fetchGoogleBooks(isbn) {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}${key ? `&key=${key}` : ''}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Google Books responded with ${response.status}`);
  }
  const body = await response.json();
  return body.items?.[0]?.volumeInfo ?? null;
}
