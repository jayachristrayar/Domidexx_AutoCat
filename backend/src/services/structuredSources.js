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
  return body[`ISBN:${isbn}`] ?? null;
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
