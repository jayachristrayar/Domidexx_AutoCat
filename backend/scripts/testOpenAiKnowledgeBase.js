// Regression tests for the two new OpenAI cataloguing-knowledge-base
// capabilities (openaiKnowledgeBase.js): hosted File Search (capability 2,
// model-controlled) and Retrieval API vector-store semantic search
// (capability 3, application-controlled) -- plus the Model 2-only,
// knowledge-base-configured-only gating in ddcClassificationService.js's
// gatherOpenAiKnowledgeEvidence/buildRetrievalQuery/buildFileSearchQuery.
//
// No live OpenAI account or network access is available in this sandbox --
// runFileSearch/searchVectorStore accept an injectable `client`/`model`
// override for exactly this reason (real callers never pass one). This
// still exercises the REAL request-shape construction and REAL response
// parsing against a fake client, not just the pure query-builder functions.
import assert from 'assert';
import {
  runFileSearch,
  searchVectorStore,
  isKnowledgeBaseConfigured,
  getConfiguredVectorStoreId,
} from '../src/services/openaiKnowledgeBase.js';
import {
  buildRetrievalQuery,
  buildFileSearchQuery,
  gatherOpenAiKnowledgeEvidence,
} from '../src/services/ddcClassificationService.js';
import { buildDdcAnalysisPrompt } from '../src/services/ddcAiClassifier.js';

// ---------------------------------------------------------------------
// Not configured -- both capabilities must be a clean, honest no-op (never
// throw, never silently pretend to have searched) when OPENAI_VECTOR_STORE_ID
// isn't set. This is the default state for every existing deployment/test
// until an operator actually configures a knowledge-base vector store.
// ---------------------------------------------------------------------
delete process.env.OPENAI_VECTOR_STORE_ID;
assert.strictEqual(isKnowledgeBaseConfigured(), false);
assert.strictEqual(getConfiguredVectorStoreId(), null);

let result = await runFileSearch('what DDC guidance applies here?');
assert.strictEqual(result.executed, false);
assert.strictEqual(result.results.length, 0);

result = await searchVectorStore('Classify this book according to DDC 23.\n\nTitle:\nFlow');
assert.strictEqual(result.executed, false);
assert.strictEqual(result.results.length, 0);

const noOpEvidence = await gatherOpenAiKnowledgeEvidence({ title: 'Flow' }, 'openai');
assert.strictEqual(noOpEvidence.fileSearchEvidence, null);
assert.strictEqual(noOpEvidence.retrievalEvidence, null);
console.log('  PASS: both capabilities cleanly no-op when OPENAI_VECTOR_STORE_ID is unset');

// ---------------------------------------------------------------------
// Configured, but provider !== 'openai' -- NVIDIA/Own Model must NEVER
// trigger these OpenAI-only capabilities, even with a vector store
// configured. This is the "do not replace Model 1 architecture" guarantee.
// ---------------------------------------------------------------------
process.env.OPENAI_VECTOR_STORE_ID = 'vs_test_123';
assert.strictEqual(isKnowledgeBaseConfigured(), true);
const nvidiaEvidence = await gatherOpenAiKnowledgeEvidence({ title: 'Flow' }, 'nvidia');
assert.strictEqual(nvidiaEvidence.fileSearchEvidence, null);
assert.strictEqual(nvidiaEvidence.retrievalEvidence, null);
const ownEvidence = await gatherOpenAiKnowledgeEvidence({ title: 'Flow' }, 'own');
assert.strictEqual(ownEvidence.fileSearchEvidence, null);
assert.strictEqual(ownEvidence.retrievalEvidence, null);
console.log('  PASS: NVIDIA/Own Model never trigger OpenAI file_search/retrieval even when a vector store is configured');

// ---------------------------------------------------------------------
// runFileSearch (capability 2): must attach the REAL hosted file_search
// tool with the configured vector store id (never hardcoded), and must
// correctly parse file_search_call output items back into queries/results.
// ---------------------------------------------------------------------
let capturedRequest = null;
const fakeFileSearchClient = {
  responses: {
    create: async (request) => {
      capturedRequest = request;
      return {
        output_text: 'DDC 23 places general psychology works under 150.',
        output: [
          {
            type: 'file_search_call',
            queries: ['DDC 23 psychology classification guidance'],
            results: [
              { file_id: 'file_abc', filename: 'ddc23-schedule.pdf', score: 0.87, attributes: { category: 'ddc' }, text: 'Class 150 covers psychology...' },
            ],
          },
        ],
      };
    },
  },
};
result = await runFileSearch('What DDC 23 classification guidance applies to a book about psychology?', {
  client: fakeFileSearchClient,
  model: 'fake-model',
});
assert.ok(capturedRequest, 'runFileSearch must actually call client.responses.create');
assert.deepStrictEqual(capturedRequest.tools, [{ type: 'file_search', vector_store_ids: ['vs_test_123'] }]);
assert.strictEqual(capturedRequest.model, 'fake-model');
assert.strictEqual(result.executed, true);
assert.strictEqual(result.resultCount, 1);
assert.strictEqual(result.results[0].filename, 'ddc23-schedule.pdf');
assert.strictEqual(result.results[0].score, 0.87);
assert.strictEqual(result.results[0].fileId, 'file_abc');
assert.deepStrictEqual(result.queries, ['DDC 23 psychology classification guidance']);
console.log('  PASS: runFileSearch attaches the real hosted file_search tool (vector store id from config, never hardcoded) and parses results, including the score');

// A call that throws must degrade to executed:false, never propagate.
const throwingClient = { responses: { create: async () => { throw new Error('simulated API failure'); } } };
result = await runFileSearch('a query', { client: throwingClient, model: 'fake-model' });
assert.strictEqual(result.executed, false);
assert.ok(result.reason.includes('simulated API failure'));
console.log('  PASS: runFileSearch degrades to executed:false on failure rather than throwing');

// ---------------------------------------------------------------------
// searchVectorStore (capability 3): must call client.vectorStores.search
// with the vector store id positionally and the query/options in the body,
// clamp max_num_results, and preserve every result's similarity score
// (never discarded).
// ---------------------------------------------------------------------
let capturedVectorStoreId = null;
let capturedBody = null;
const fakeRetrievalClient = {
  vectorStores: {
    search: async (vectorStoreId, body) => {
      capturedVectorStoreId = vectorStoreId;
      capturedBody = body;
      return {
        data: [
          { file_id: 'file_1', filename: 'ddc23-150-159.pdf', score: 0.91, attributes: { category: 'ddc' }, content: [{ type: 'text', text: 'Psychology of self-actualization: 158.1' }] },
          { file_id: 'file_2', filename: 'marc21-500-notes.pdf', score: 0.42, attributes: { category: 'marc' }, content: [{ type: 'text', text: 'General note field usage.' }] },
        ],
      };
    },
  },
};
const bookQuery = buildRetrievalQuery({
  title: 'Flow',
  subtitle: 'the classic work on how to achieve happiness',
  description: 'An exploration of optimal experience and the psychology of engagement.',
  subjects: ['Happiness', 'Attention'],
  table_of_contents: 'Happiness Revisited; The Anatomy of Consciousness',
  authors: ['Mihaly Csikszentmihalyi'],
});
// Product spec: never search using only the ISBN -- must be built from the
// book's actual intellectual content.
assert.ok(bookQuery.includes('Flow'));
assert.ok(bookQuery.includes('optimal experience'));
assert.ok(bookQuery.includes('Happiness'));
assert.ok(bookQuery.includes('Csikszentmihalyi'));
assert.ok(!/^\d{9,13}$/.test(bookQuery.trim()), 'retrieval query must not be a bare ISBN');

result = await searchVectorStore(bookQuery, { maxResults: 5, rewriteQuery: true, client: fakeRetrievalClient });
assert.strictEqual(capturedVectorStoreId, 'vs_test_123');
assert.strictEqual(capturedBody.query, bookQuery);
assert.strictEqual(capturedBody.max_num_results, 5);
assert.strictEqual(capturedBody.rewrite_query, true);
assert.strictEqual(result.executed, true);
assert.strictEqual(result.resultCount, 2);
assert.strictEqual(result.results[0].score, 0.91);
assert.strictEqual(result.results[1].score, 0.42);
assert.ok(result.results[0].content.includes('158.1'));
console.log('  PASS: searchVectorStore calls client.vectorStores.search(vectorStoreId, {...}) with a real book-content query, preserving every similarity score');

// max_num_results must be clamped into OpenAI's 1-50 range.
result = await searchVectorStore('x', { maxResults: 500, client: fakeRetrievalClient });
assert.strictEqual(capturedBody.max_num_results, 50);
result = await searchVectorStore('x', { maxResults: 0, client: fakeRetrievalClient });
assert.strictEqual(capturedBody.max_num_results, 1);
console.log('  PASS: max_num_results is clamped to OpenAI\'s 1-50 range');

// score_threshold/ranker map onto ranking_options when provided, and are
// simply absent otherwise (never sent as undefined/null noise).
result = await searchVectorStore('x', { scoreThreshold: 0.5, ranker: 'auto', client: fakeRetrievalClient });
assert.deepStrictEqual(capturedBody.ranking_options, { ranker: 'auto', score_threshold: 0.5 });
result = await searchVectorStore('x', { client: fakeRetrievalClient });
assert.strictEqual(capturedBody.ranking_options, undefined);
console.log('  PASS: ranking_options (score_threshold/ranker) only sent when explicitly requested');

// ---------------------------------------------------------------------
// buildFileSearchQuery: a natural-language CATALOGUING question, never
// "what is this book" (that's web_search's job) and never the bare ISBN.
// ---------------------------------------------------------------------
const fileSearchQuery = buildFileSearchQuery({ isbn: '9780712657594', title: 'Flow', subjects: ['Happiness', 'Attention', 'Psychology'] });
assert.ok(/DDC 23|MARC21|cataloguing/i.test(fileSearchQuery));
assert.ok(fileSearchQuery.includes('Flow'));
assert.ok(!fileSearchQuery.trim().startsWith('9780712657594'));
console.log('  PASS: buildFileSearchQuery asks a cataloguing-knowledge question built from the book\'s actual subjects, never the bare ISBN');

// ---------------------------------------------------------------------
// Full gatherOpenAiKnowledgeEvidence pass-through for provider === 'openai'
// (still using injected clients would require plumbing overrides through
// gatherOpenAiKnowledgeEvidence itself, which real callers never need --
// instead this confirms the function's OWN gating/shape contract: since no
// real OPENAI_API_KEY is configured in this sandbox, both capabilities
// correctly come back as configured-but-not-executed, never throwing).
// ---------------------------------------------------------------------
delete process.env.OPENAI_API_KEY;
const openaiEvidenceNoKey = await gatherOpenAiKnowledgeEvidence({ title: 'Flow', description: 'A book about happiness.' }, 'openai');
assert.strictEqual(openaiEvidenceNoKey.retrievalEvidence.executed, false);
assert.strictEqual(openaiEvidenceNoKey.fileSearchEvidence.executed, false);
console.log('  PASS: gatherOpenAiKnowledgeEvidence degrades cleanly (executed:false) when OPENAI_API_KEY is unavailable, still provider-gated correctly');

// ---------------------------------------------------------------------
// The DDC prompt must actually include the knowledge-base evidence, tagged
// by mechanism, when present -- and must say it is supporting evidence
// only, never a whitelist.
// ---------------------------------------------------------------------
const promptWithKnowledge = buildDdcAnalysisPrompt(
  { title: 'Flow', description: 'A book about happiness.' },
  [],
  null,
  {
    retrievalEvidence: { executed: true, results: [{ filename: 'ddc23-150-159.pdf', fileId: 'file_1', score: 0.91, content: 'Psychology of self-actualization: 158.1' }] },
    fileSearchEvidence: { executed: true, outputText: 'DDC 23 places general psychology works under 150.', results: [] },
  }
);
assert.ok(promptWithKnowledge.includes('ddc23-150-159.pdf'));
assert.ok(promptWithKnowledge.includes('158.1'));
assert.ok(promptWithKnowledge.includes('DDC 23 places general psychology works under 150.'));
assert.ok(/never treat it as a whitelist/i.test(promptWithKnowledge));

const promptWithoutKnowledge = buildDdcAnalysisPrompt({ title: 'Flow', description: 'A book about happiness.' }, [], null, null);
assert.ok(!promptWithoutKnowledge.includes('ddc23-150-159.pdf'));
console.log('  PASS: buildDdcAnalysisPrompt includes knowledge-base evidence (tagged by mechanism) only when supplied, and frames it as supporting evidence, never a whitelist');

delete process.env.OPENAI_VECTOR_STORE_ID;

console.log('OpenAI knowledge-base (File Search + Retrieval API) tests passed');
