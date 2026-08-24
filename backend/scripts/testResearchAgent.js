import assert from 'assert';
import http from 'node:http';

// researchAgent.js statically imports usageService.js, which constructs a
// Postgres pool at import time (db/index.js) -- unlike the DDC test
// scripts, which only ever reach the DB via a dynamic import inside a
// try/catch, so they run fine without one. No real DB is needed here: the
// pool is never actually queried successfully, recordUsage already catches
// that itself, and the point of this test is the tool-calling loop, not
// usage logging -- a harmless placeholder value lets the module load.
process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/autocat_test_placeholder';

const { runAgenticResearch } = await import('../src/llm/researchAgent.js');

// Exercises the full agentic tool-calling loop against a local mock
// OpenAI-compatible endpoint (no real NVIDIA/OpenAI/network access needed)
// -- verifies that runAgenticResearch (a) actually drives multiple rounds
// of tool calls the "model" (our mock) requests, (b) executes each tool
// for real (fetch_page really fetches the given URL from this same mock
// server), and (c) only returns a final record once the "model" stops
// requesting tools and answers with the required JSON shape.

const TEST_ISBN = '9789999999999';
let chatCallCount = 0;
const seenToolCalls = [];

const BOOK_PAGE_HTML = `<!doctype html><html><head>
<title>Test Book</title>
<script type="application/ld+json">
{"@type":"Book","name":"Test Book","author":[{"@type":"Person","name":"Jane Author"}],"publisher":{"@type":"Organization","name":"Test Publisher"},"datePublished":"2020","description":"A test book about testing."}
</script>
</head><body>DDC 005 Computer science.</body></html>`;

function toolCallMessage(id, name, args) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
    usage: { total_tokens: 42 },
    model: 'mock-model',
  };
}

function finalAnswerMessage(bookPageUrl) {
  const payload = {
    isbn: TEST_ISBN,
    title: 'Test Book',
    subtitle: null,
    authors: ['Jane Author'],
    editors: [],
    illustrators: [],
    translators: [],
    publisher: 'Test Publisher',
    publish_date: '2020',
    edition: null,
    physical_description: { pages: null, dimensions: null },
    description: 'A test book about testing.',
    subjects: ['Testing'],
    series: null,
    language: 'eng',
    table_of_contents: null,
    existing_classifications: [{ number: '005', source: bookPageUrl }],
    conflicts_found: null,
  };
  return {
    choices: [{ message: { role: 'assistant', content: JSON.stringify(payload), tool_calls: null } }],
    usage: { total_tokens: 42 },
    model: 'mock-model',
  };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/book') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(BOOK_PAGE_HTML);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      chatCallCount += 1;
      const parsed = JSON.parse(body);
      const lastToolMessage = [...parsed.messages].reverse().find((m) => m.role === 'tool');
      if (lastToolMessage) seenToolCalls.push(JSON.parse(lastToolMessage.content));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (chatCallCount === 1) {
        res.end(JSON.stringify(toolCallMessage('call_1', 'lookup_structured_apis', { isbn: TEST_ISBN })));
      } else if (chatCallCount === 2) {
        res.end(JSON.stringify(toolCallMessage('call_2', 'search_web', { query: `"${TEST_ISBN}"` })));
      } else if (chatCallCount === 3) {
        const bookPageUrl = `http://127.0.0.1:${server.address().port}/book`;
        res.end(JSON.stringify(toolCallMessage('call_3', 'fetch_page', { url: bookPageUrl })));
      } else {
        res.end(JSON.stringify(finalAnswerMessage(`http://127.0.0.1:${server.address().port}/book`)));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const result = await runAgenticResearch({
  isbn: TEST_ISBN,
  variants: [TEST_ISBN],
  provider: 'own',
  ownApiConfig: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'mock-model' },
  userId: null,
});

server.close();

assert.strictEqual(chatCallCount, 4, 'expected 3 tool-calling rounds + 1 final answer');
assert.ok(result, 'runAgenticResearch should have returned a record');
assert.strictEqual(result.title, 'Test Book');
assert.deepStrictEqual(result.authors, ['Jane Author']);
assert.strictEqual(result.publisher, 'Test Publisher');
assert.strictEqual(result.sources.method, 'agent_research');
assert.strictEqual(result.sources.provider, 'own');
assert.strictEqual(result.sources.tool_calls, 3);
assert.strictEqual(result.sources.searches, 1);
assert.strictEqual(result.sources.pages_fetched, 1);
assert.strictEqual(result.sources.pages_accepted, 1);
assert.ok(result.sources.citations.some((c) => c.url.endsWith('/book')));

// The fetch_page tool call must have actually fetched the real page (not a
// canned/fabricated response) -- the tool result fed back to the "model"
// should carry the JSON-LD-derived title, proving the tool really ran.
const fetchPageResult = seenToolCalls.find((r) => r.title === 'Test Book');
assert.ok(fetchPageResult, 'fetch_page tool result should include the real extracted title');
assert.strictEqual(fetchPageResult.publisher, 'Test Publisher');

console.log('Research agent tool-loop tests passed');
