// AutoCat's OpenAI CATALOGUING KNOWLEDGE BASE capabilities -- distinct from,
// and never a substitute for, the book-specific web research in
// isbnLookup.js/webSearchScrape.js (that answers "what is this actual
// book?"; this module answers "what does AutoCat's cataloguing knowledge
// base say?" / "what knowledge in the vector store is semantically
// relevant to classifying this book?"). Both capabilities here are
// Model 2 (OpenAI) only, entirely additive, and gracefully inert when
// OPENAI_VECTOR_STORE_ID isn't configured -- Model 1 (NVIDIA), Your Own
// Model, and every existing Model 2 code path work identically without it.
//
// Two capabilities, two different control models (product requirement --
// do not collapse them into one call):
//
//   - runFileSearch: the Responses API's hosted `file_search` tool.
//     MODEL-CONTROLLED -- the model itself decides whether/what to search
//     within the configured vector store; we only supply the tool and read
//     back what it actually did (queries/results), the same "the model
//     decides" contract isbnLookup.js's web_search usage already has.
//
//   - searchVectorStore: the Retrieval API (client.vectorStores.search).
//     APPLICATION-CONTROLLED -- our own code decides the query and reads
//     the raw scored chunks directly, never leaving it to the model to
//     decide whether to search at all. This is what lets DDC classification
//     build a genuinely semantic query from the book's actual title/
//     description/subjects/TOC, rather than a bare ISBN.
//
// Neither the API key nor the vector store id ever leaves this backend --
// the extension has no route to either, exactly like every other OpenAI
// call in this codebase (see llm/router.js, isbnLookup.js).
import { getAvailableOpenAiModel, getOpenAiClientForFallback } from './openaiModelSelector.js';

const FILE_SEARCH_TIMEOUT_MS = 20_000;
const RETRIEVAL_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESULTS = 8;
const MAX_ALLOWED_RESULTS = 50; // OpenAI's own ceiling for max_num_results

export function getConfiguredVectorStoreId() {
  return process.env.OPENAI_VECTOR_STORE_ID || null;
}

// isKnowledgeBaseConfigured() -- both capabilities in this module are gated
// on the SAME env var: a vector store with no id to search is nothing to
// search. Callers use this to skip gathering entirely (never attempted,
// never a failure) rather than making a call that will just no-op.
export function isKnowledgeBaseConfigured() {
  return Boolean(getConfiguredVectorStoreId());
}

function notConfiguredResult(reason) {
  return { executed: false, reason, queries: [], results: [], resultCount: 0 };
}

function extractFileSearchCallResults(response) {
  const calls = (response?.output ?? []).filter((item) => item?.type === 'file_search_call');
  const queries = calls.flatMap((call) => call.queries ?? []);
  const results = calls.flatMap((call) =>
    (call.results ?? []).map((r) => ({
      fileId: r.file_id ?? null,
      filename: r.filename ?? null,
      score: typeof r.score === 'number' ? r.score : null,
      attributes: r.attributes ?? null,
      text: r.text ?? null,
    }))
  );
  return { queries, results };
}

// runFileSearch(query) -- capability 2 (OPENAI FILE SEARCH). `query` should
// be a natural-language cataloguing question ("what DDC 23 guidance
// applies to...") -- never the bare ISBN, and never "what is this book"
// (that's web_search's job). Never throws: a missing vector store id, a
// missing API key, or a failed call all come back as `{ executed: false,
// reason }` so callers can log/skip cleanly, same convention every other
// research source in this codebase already follows (webSearchScrape.js,
// structuredSources.js).
// `client`/`model` overrides exist only so this can be unit-tested against a
// fake client with no live OpenAI account/network access (see
// testOpenAiKnowledgeBase.js) -- every real caller omits both and gets the
// actual configured client/model.
export async function runFileSearch(query, { client: clientOverride, model: modelOverride } = {}) {
  const vectorStoreId = getConfiguredVectorStoreId();
  if (!vectorStoreId) return notConfiguredResult('OPENAI_VECTOR_STORE_ID not configured');

  const model = modelOverride ?? (await getAvailableOpenAiModel());
  const client = clientOverride ?? getOpenAiClientForFallback();
  if (!model || !client) return notConfiguredResult('OpenAI is not configured (OPENAI_API_KEY/model unavailable)');

  const startedAt = Date.now();
  try {
    const response = await client.responses.create(
      {
        model,
        tools: [{ type: 'file_search', vector_store_ids: [vectorStoreId] }],
        input: query,
      },
      { timeout: FILE_SEARCH_TIMEOUT_MS, maxRetries: 0 }
    );
    const { queries, results } = extractFileSearchCallResults(response);
    console.info(
      `FILE_SEARCH_DEBUG executed=true queries=${queries.length} results=${results.length} durationMs=${Date.now() - startedAt}`
    );
    return { executed: true, queries, results, resultCount: results.length, outputText: response.output_text ?? null };
  } catch (error) {
    console.error(`FILE_SEARCH_DEBUG executed=false durationMs=${Date.now() - startedAt} error=${error.message}`);
    return notConfiguredResult(error.message);
  }
}

// searchVectorStore(query, options) -- capability 3 (OPENAI RETRIEVAL API /
// vector-store semantic search). `query` must be built from the book's
// actual intellectual content (title/description/subjects/TOC), never the
// bare ISBN -- see ddcClassificationService.js's buildRetrievalQuery for
// the caller that constructs it. Captures file_id/filename/score/
// attributes/content for every result -- the similarity score is never
// discarded, so callers can apply their own relevance threshold rather than
// trusting every returned chunk equally.
//
// `maxResults` defaults to a modest 8 (product requirement: "approximately
// 5-10 results initially... do not retrieve 50 results for every ISBN"),
// clamped to OpenAI's own 1-50 range. `rewriteQuery`/`filters`/
// `scoreThreshold`/`ranker` map directly onto the Retrieval API's own
// rewrite_query / filters / ranking_options parameters -- callers only pass
// what they actually need; none of these are required.
export async function searchVectorStore(
  query,
  { maxResults = DEFAULT_MAX_RESULTS, rewriteQuery = true, filters, scoreThreshold, ranker, client: clientOverride } = {}
) {
  const vectorStoreId = getConfiguredVectorStoreId();
  if (!vectorStoreId) return notConfiguredResult('OPENAI_VECTOR_STORE_ID not configured');

  const client = clientOverride ?? getOpenAiClientForFallback();
  if (!client) return notConfiguredResult('OpenAI is not configured (OPENAI_API_KEY unavailable)');

  const requestedMaxResults = Number.isFinite(maxResults) ? Math.round(maxResults) : DEFAULT_MAX_RESULTS;
  const clampedMaxResults = Math.min(Math.max(requestedMaxResults, 1), MAX_ALLOWED_RESULTS);
  const rankingOptions =
    scoreThreshold != null || ranker
      ? { ...(ranker ? { ranker } : {}), ...(scoreThreshold != null ? { score_threshold: scoreThreshold } : {}) }
      : undefined;

  const startedAt = Date.now();
  try {
    const page = await client.vectorStores.search(
      vectorStoreId,
      {
        query,
        max_num_results: clampedMaxResults,
        rewrite_query: rewriteQuery,
        ...(filters ? { filters } : {}),
        ...(rankingOptions ? { ranking_options: rankingOptions } : {}),
      },
      { timeout: RETRIEVAL_TIMEOUT_MS, maxRetries: 0 }
    );
    const results = (page.data ?? []).map((r) => ({
      fileId: r.file_id,
      filename: r.filename,
      score: r.score,
      attributes: r.attributes ?? null,
      content: (r.content ?? []).map((c) => c.text).join('\n'),
    }));
    console.info(
      `RETRIEVAL_DEBUG executed=true query=${JSON.stringify(String(query).slice(0, 100))} resultCount=${results.length} scores=[${results
        .map((r) => (typeof r.score === 'number' ? r.score.toFixed(3) : r.score))
        .join(',')}] durationMs=${Date.now() - startedAt}`
    );
    return { executed: true, query, results, resultCount: results.length };
  } catch (error) {
    console.error(`RETRIEVAL_DEBUG executed=false durationMs=${Date.now() - startedAt} error=${error.message}`);
    return notConfiguredResult(error.message);
  }
}
