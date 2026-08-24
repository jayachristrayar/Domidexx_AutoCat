// Agentic ISBN research for providers with no hosted browsing tool of
// their own (NVIDIA/NIM, and any user-supplied "Your Own Model" endpoint).
//
// Architecture requirement this file exists to satisfy: Model 1 (NVIDIA)
// and Model 2 (OpenAI) -- and Model 3, the librarian's own API -- are each
// FULL cataloguing agents, not passive reasoners fed a metadata blob a
// separate scraper assembled. OpenAI's path (lookupIsbnWebFallback in
// isbnLookup.js) already satisfies this: the Responses API's hosted
// `web_search` tool lets the model itself decide what to search and which
// results to read. NVIDIA's NIM endpoint and arbitrary OpenAI-compatible
// "own" endpoints have no equivalent hosted tool, so this module gives them
// the same capability explicitly, via standard OpenAI-style function
// calling: the model is handed tool definitions (search_web/fetch_page/
// lookup_structured_apis), and a loop here does nothing but execute
// whichever tool call the model itself decided to make, feed the result
// back, and let the model decide the next step -- exactly the same
// "selected model is the agent responsible for deciding what to search,
// which sources are relevant, and how that evidence affects the final
// catalogue record" contract OpenAI's hosted tool already provides.
//
// This is deliberately NOT a mandatory pipeline that replaces the model's
// own research: every tool call here only happens because the model asked
// for it. If the endpoint doesn't support tool calling at all (some
// self-hosted "own" endpoints won't), the call fails fast and
// isbnLookup.js's researchWebForIsbn falls back to the key-less
// webSearchAndScrape pass -- a last resort, not the primary path.
import OpenAI from 'openai';
import { getNvidiaClient, DEFAULT_NVIDIA_MODEL, extractJson } from './router.js';
import { searchWeb, fetchPageMetadata } from '../services/webSearchScrape.js';
import { fetchOpenLibrary, fetchGoogleBooks } from '../services/structuredSources.js';
import { recordUsage } from '../services/usageService.js';

const MAX_AGENT_ITERATIONS = 6;
const AGENT_CALL_TIMEOUT_MS = 30_000;
const OVERALL_BUDGET_MS = 90_000;
const MAX_TOOL_RESULT_CHARS = 6000;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        'Search the public web for pages about this book. Returns a list of {title, url}. Try the exact ISBN (plain and hyphenated), the ISBN-10/ISBN-13 equivalent, and title+author queries -- do not rely on your own knowledge of the book without searching first.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_page',
      description:
        'Fetch one specific URL (from a previous search_web result) and extract its bibliographic metadata: title, authors, publisher, edition, publish_date, pages, language, description, subjects, and any DDC/Dewey classification mentioned on the page.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The exact URL to fetch, from a search_web result.' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_structured_apis',
      description:
        'Look up this exact ISBN directly in Open Library and Google Books, two structured bibliographic databases. Use this first -- it is faster and more reliable than a web search when it has data for this ISBN.',
      parameters: {
        type: 'object',
        properties: { isbn: { type: 'string', description: 'The ISBN to look up, digits only.' } },
        required: ['isbn'],
      },
    },
  },
];

const RESPONSE_SHAPE =
  '{"isbn": string, "title": string|null, "subtitle": string|null, "authors": string[], "editors": string[], "illustrators": string[], "translators": string[], "publisher": string|null, "publish_date": string|null, "edition": string|null, "physical_description": {"pages": number|null, "dimensions": string|null}, "description": string|null, "subjects": string[], "series": string|null, "language": string|null, "table_of_contents": string|null, "existing_classifications": [{"number": string, "source": string}], "conflicts_found": string|null}';

function buildSystemPrompt(isbn, variants) {
  const otherForm = variants.find((v) => v !== isbn) ?? null;
  return [
    'You are a professional cataloguing librarian AI agent responsible for researching a specific book before it is catalogued.',
    `You must research ISBN ${isbn}${otherForm ? ` (also try its other form, ${otherForm})` : ''} using the tools you have been given (search_web, fetch_page, lookup_structured_apis) before answering.`,
    'Do NOT answer from your own memory of the book alone -- you must call at least one tool and use what it returns as your evidence. If your first attempt finds little, try different queries (exact ISBN, hyphenated ISBN, title + author, author + ISBN) and fetch more than one page before concluding nothing more is available.',
    'Compare what different sources say rather than trusting the first result blindly -- if sources disagree on a fact, prefer library/publisher sources over booksellers, and say so in conflicts_found.',
    `Once you have gathered enough evidence, respond with ONLY strict JSON matching exactly this shape (no markdown fences, no commentary, no further tool calls): ${RESPONSE_SHAPE}`,
    'Use null for unknown scalar fields and [] for unknown list fields. existing_classifications is any DDC/Dewey (or similar) classification number you found already assigned to this book on a library catalogue page -- supporting evidence only, not something to invent.',
  ].join('\n\n');
}

async function executeTool(name, rawArgs, isbn) {
  let args = {};
  try {
    args = JSON.parse(rawArgs || '{}');
  } catch {
    // malformed tool-call arguments -- treat as empty args rather than
    // aborting the whole research run over one bad call
  }

  if (name === 'search_web') {
    const query = String(args.query || isbn);
    const results = await searchWeb(query);
    return { results: results.slice(0, 8).map((r) => ({ title: r.title, url: r.url })) };
  }

  if (name === 'fetch_page') {
    const url = String(args.url || '');
    if (!url) return { error: 'no url provided' };
    const metadata = await fetchPageMetadata(url);
    return { url, ...metadata };
  }

  if (name === 'lookup_structured_apis') {
    const targetIsbn = String(args.isbn || isbn).replace(/[-\s]/g, '');
    const [ol, gb] = await Promise.allSettled([fetchOpenLibrary(targetIsbn), fetchGoogleBooks(targetIsbn)]);
    return {
      openLibrary: ol.status === 'fulfilled' ? ol.value : { error: ol.reason?.message },
      googleBooks: gb.status === 'fulfilled' ? gb.value : { error: gb.reason?.message },
    };
  }

  return { error: `unknown tool "${name}"` };
}

function getOwnApiClient(ownApiConfig) {
  if (!ownApiConfig?.baseUrl || !ownApiConfig?.apiKey) return null;
  return new OpenAI({ apiKey: ownApiConfig.apiKey, baseURL: ownApiConfig.baseUrl, timeout: AGENT_CALL_TIMEOUT_MS, maxRetries: 0 });
}

function clientAndModelFor(provider, ownApiConfig) {
  if (provider === 'nvidia') {
    const client = getNvidiaClient();
    if (!client) return null;
    return { client, model: process.env.NVIDIA_MODEL || DEFAULT_NVIDIA_MODEL };
  }
  if (provider === 'own') {
    const client = getOwnApiClient(ownApiConfig);
    if (!client || !ownApiConfig?.model) return null;
    return { client, model: ownApiConfig.model };
  }
  return null;
}

// runAgenticResearch({ isbn, variants, provider, ownApiConfig, userId }) --
// returns a normalized record shaped like every other extractor in
// isbnLookup.js (title/authors/publisher/.../sources), or null when the
// endpoint isn't configured, doesn't support tool calling, or the model
// genuinely found nothing usable after researching.
export async function runAgenticResearch({ isbn, variants = [isbn], provider, ownApiConfig, userId }) {
  const setup = clientAndModelFor(provider, ownApiConfig);
  if (!setup) {
    console.info(`ISBN research agent: ${provider} is not configured, skipping agentic research`);
    return null;
  }
  const { client, model } = setup;

  const pipelineStartedAt = Date.now();
  const messages = [
    { role: 'system', content: buildSystemPrompt(isbn, variants) },
    { role: 'user', content: `Research ISBN ${isbn} now using your tools, then respond with the final JSON.` },
  ];

  let toolCallCount = 0;
  let searchCount = 0;
  let pagesFetched = 0;
  let pagesAccepted = 0;
  const citations = [];

  for (let iteration = 1; iteration <= MAX_AGENT_ITERATIONS; iteration += 1) {
    if (Date.now() - pipelineStartedAt > OVERALL_BUDGET_MS) {
      console.warn(`ISBN research agent (${provider}/${model}): overall time budget exceeded for ${isbn} after ${iteration - 1} iterations`);
      break;
    }

    let response;
    try {
      response = await client.chat.completions.create(
        { model, messages, tools: TOOLS, tool_choice: 'auto' },
        { timeout: AGENT_CALL_TIMEOUT_MS, maxRetries: 0 }
      );
    } catch (error) {
      // A provider/endpoint that doesn't support tool calling at all
      // typically errors on the very first call -- this is the expected,
      // recoverable "fall back to webSearchAndScrape" case, not a bug.
      console.error(`ISBN research agent (${provider}): call failed for ${isbn} on iteration ${iteration}: ${error.message}`);
      return null;
    }

    await recordUsage({
      userId,
      provider,
      model,
      requestType: 'ISBN',
      tokensUsed: response.usage?.total_tokens,
      status: 'success',
    });

    const message = response.choices?.[0]?.message;
    if (!message) {
      console.error(`ISBN research agent (${provider}): empty response for ${isbn} on iteration ${iteration}`);
      return null;
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      messages.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });
      for (const call of message.tool_calls) {
        toolCallCount += 1;
        const toolName = call.function?.name;
        console.info(`ISBN research agent (${provider}/${model}): tool call ${toolCallCount} -- ${toolName}(${call.function?.arguments})`);
        let result;
        try {
          result = await executeTool(toolName, call.function?.arguments, isbn);
        } catch (error) {
          result = { error: error.message };
        }
        if (toolName === 'search_web') {
          searchCount += 1;
          for (const r of result.results ?? []) citations.push({ url: r.url, title: r.title });
        } else if (toolName === 'fetch_page') {
          pagesFetched += 1;
          if (!result.error) {
            pagesAccepted += 1;
            citations.push({ url: result.url, title: result.title });
          }
        }
        const content = JSON.stringify(result);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: content.length > MAX_TOOL_RESULT_CHARS ? `${content.slice(0, MAX_TOOL_RESULT_CHARS)}…(truncated)` : content,
        });
      }
      continue;
    }

    // No tool calls -- the model considers its research complete and this
    // is its final answer.
    console.info(
      `ISBN research agent (${provider}/${model}): finished for ${isbn} after ${iteration} iterations, ${toolCallCount} tool calls (${searchCount} searches, ${pagesFetched} pages fetched, ${pagesAccepted} accepted), ${Date.now() - pipelineStartedAt}ms`
    );

    let parsed;
    try {
      parsed = JSON.parse(extractJson(message.content ?? ''));
    } catch (error) {
      console.error(`ISBN research agent (${provider}): could not parse final JSON for ${isbn}: ${error.message}`);
      return null;
    }

    if (!parsed.title) {
      console.warn(`ISBN research agent (${provider}): no title found for ${isbn} after agentic research -- treating as not found`);
      return null;
    }
    if (parsed.conflicts_found) {
      console.info(`ISBN research agent (${provider}): source conflict for ${isbn}: ${parsed.conflicts_found}`);
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
      language: parsed.language ?? null,
      table_of_contents: parsed.table_of_contents ?? null,
      existing_classifications: Array.isArray(parsed.existing_classifications)
        ? parsed.existing_classifications
            .filter((c) => c?.number)
            .map((c) => ({ source: c.source || 'agent_research', number: String(c.number), edition: null }))
        : [],
      conflicts: [],
      sources: {
        method: 'agent_research',
        provider,
        model,
        tool_calls: toolCallCount,
        searches: searchCount,
        pages_fetched: pagesFetched,
        pages_accepted: pagesAccepted,
        citations: dedupeCitations(citations),
        note: 'verify carefully -- researched and extracted by the selected AI model itself via live web search tools, not confirmed against a structured bibliographic database',
      },
    };
  }

  console.warn(`ISBN research agent (${provider}): exceeded ${MAX_AGENT_ITERATIONS} iterations for ${isbn} without a final answer`);
  return null;
}

function dedupeCitations(citations) {
  const seen = new Set();
  return citations.filter((c) => {
    if (!c.url || seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}
