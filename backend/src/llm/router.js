// backend/src/llm/router.js did not exist before this change -- it's built
// here from scratch (there was no prior "invent a DDC number" version to
// preserve). Architecture and every non-obvious choice is documented
// inline; see the PR that introduced this file for the full rationale.
import OpenAI from 'openai';
import { getAvailableOpenAiModel, getOpenAiClientForFallback } from '../services/openaiModelSelector.js';

// NVIDIA's hosted NIM endpoint (integrate.api.nvidia.com/v1, matching
// NVIDIA_BASE_URL from .env.example) is OpenAI-compatible via the standard
// Chat Completions surface, NOT the newer Responses API -- that's
// OpenAI-only. So both providers reuse the same `openai` npm client; OpenAI
// calls responses.create(), NVIDIA calls chat.completions.create().
//
// Unlike OpenAI (openaiModelSelector.js), NVIDIA's /v1/models response
// doesn't need to be probed here: building a whole auto-selection subsystem
// for a provider this task doesn't otherwise touch would be scope well
// beyond "ground the 082 instruction in real candidates." NVIDIA_MODEL is a
// plain env var instead, with a documented default.
export const DEFAULT_NVIDIA_MODEL = 'meta/llama-3.3-70b-instruct';

// See openaiModelSelector.js's CLIENT_TIMEOUT_MS for why this exists at
// all: an unbounded provider call (the SDK's own default is 10 minutes)
// risks being killed by the hosting platform's own request timeout before
// this app ever gets to respond with a real, diagnosable error.
const CLIENT_TIMEOUT_MS = 55_000;
// callOpenAi/callNvidia below use a much tighter per-call timeout -- these
// are single-shot text completions (no web_search tool), which normally
// return in a few seconds; ddcClassificationService.js already retries a
// rejected/invalid answer itself with corrective feedback, so a stuck SDK
// call failing fast here matters more than the SDK's own retry behavior.
const COMPLETION_TIMEOUT_MS = 20_000;

let nvidiaClient = null;
// Exported so llm/researchAgent.js can reuse the exact same NVIDIA client
// setup for its own agentic (tool-calling) research calls, rather than
// duplicating API-key/base-URL wiring a second time.
export function getNvidiaClient() {
  if (!process.env.NVIDIA_API_KEY || !process.env.NVIDIA_BASE_URL) return null;
  if (!nvidiaClient) {
    nvidiaClient = new OpenAI({
      apiKey: process.env.NVIDIA_API_KEY,
      baseURL: process.env.NVIDIA_BASE_URL,
      timeout: CLIENT_TIMEOUT_MS,
      maxRetries: 1,
    });
  }
  return nvidiaClient;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'for', 'to', 'with', 'by',
  'is', 'are', 'was', 'were', 'this', 'that', 'from', 'as', 'at', 'it', 'its',
  'his', 'her', 'their', 'about', 'into', 'over', 'also', 'been', 'has', 'have',
]);

function extractSignificantWords(text, max = 8) {
  if (!text) return [];
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOPWORDS.has(word));
  return [...new Set(words)].slice(0, max);
}

// Keywords for findCandidateDdcNumbers: the book's title and subjects as
// whole phrases (already concise, meaningful search units), plus a small
// set of significant individual words pulled from the description (a full
// paragraph would internally AND all its words via plainto_tsquery and
// essentially never match -- see ddcLookup.js).
export function deriveDdcKeywords(normalizedBiblioData) {
  const keywords = [];
  if (normalizedBiblioData.title) keywords.push(normalizedBiblioData.title);
  for (const subject of normalizedBiblioData.subjects ?? []) {
    if (subject) keywords.push(subject);
  }
  keywords.push(...extractSignificantWords(normalizedBiblioData.description));
  return keywords;
}

function buildDdcCandidateInstruction(candidates) {
  const list = candidates
    .map((c) => `- ${c.term}${c.qualifier ? ` (${c.qualifier})` : ''} -> ${c.ddc_number}`)
    .join('\n');
  return (
    `Here are candidate DDC numbers found in the official DDC 23 relative index for this book's subject matter:\n${list}\n\n` +
    `Choose the most appropriate number from these candidates if one fits well. Only propose a number NOT in this list if none of the candidates are a reasonable match, and if you do, mark confidence as "low" and explain why in a notes field.`
  );
}

const NO_CANDIDATES_INSTRUCTION =
  'No candidate DDC numbers were found in the official DDC 23 relative index for this book\'s subject matter. ' +
  'Draft the 082 field from your own knowledge, but you MUST mark confidence as "low" in that case, since it is unverified against our DDC data.';

const FIELD_TAG_NOTES = {
  '082': 'Dewey Decimal Classification number ($a class number, $b Cutter mark from the main entry or title, $2 DDC edition "23").',
  '1xx': 'Main entry (100 personal name / 110 corporate name / 111 meeting name) -- choose per AACR2 ch.21 (rules/shared/isbd_and_entry_rules.json, "AACR2 main/added entry choice rules").',
  '6xx': 'Subject added entries (600/610/650) -- topical/personal/corporate subject headings for this work.',
  '520': 'Summary/abstract note -- concise, neutral description of scope and content, not promotional copy.',
  '7xx': 'Added entries (700/710/711) for contributors named in 245$c who are not the 1xx main entry.',
};

function buildBibliographicSummary(normalizedBiblioData) {
  const { title, subtitle, authors, editors, illustrators, translators, publisher, publish_date, subjects, description, series } = normalizedBiblioData;
  return JSON.stringify(
    { title, subtitle, authors, editors, illustrators, translators, publisher, publish_date, subjects, description, series },
    null,
    2
  );
}

const RESPONSE_SHAPE =
  '{"fields": [{"tag": string, "indicators": [string, string], "subfields": [{"code": string, "value": string}], "confidence": "high"|"medium"|"low", "notes": string|null}]}';

async function buildSystemPrompt({ skeleton, fieldsNeeded, normalizedBiblioData, ruleProfile, ddcCandidates }) {
  const parts = [];
  parts.push(
    `You are a MARC 21 cataloguing assistant following ${ruleProfile.cataloguing_standard}. ` +
      'Draft ONLY the MARC fields listed below, as a book cataloguer would, following AACR2/ISBD punctuation conventions. ' +
      `Respond with strict JSON matching exactly this shape, no markdown fences, no commentary: ${RESPONSE_SHAPE}`
  );

  parts.push(
    `Fields needed: ${fieldsNeeded.map((tag) => `${tag} (${FIELD_TAG_NOTES[tag] ?? tag})`).join('; ')}.`
  );

  parts.push(`Book bibliographic data:\n${buildBibliographicSummary(normalizedBiblioData)}`);

  if (skeleton && skeleton.length > 0) {
    parts.push(
      `MARC fields already mechanically determined for this record (for context/consistency -- do not redraft these):\n${JSON.stringify(skeleton, null, 2)}`
    );
  }

  if (fieldsNeeded.includes('082')) {
    parts.push(
      ddcCandidates.length > 0 ? buildDdcCandidateInstruction(ddcCandidates) : NO_CANDIDATES_INSTRUCTION
    );
  }

  return parts.join('\n\n');
}

// Exported so other AI-driven services (e.g. ddcAiClassifier.js) can reuse
// the same provider-selection/calling primitives instead of reimplementing
// OpenAI/NVIDIA client setup a second time.
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

export async function callOpenAi(systemPrompt) {
  const model = await getAvailableOpenAiModel();
  if (!model) throw new Error('no usable OpenAI model available');
  const client = getOpenAiClientForFallback();
  if (!client) throw new Error('OPENAI_API_KEY is not configured');

  const startedAt = Date.now();
  try {
    const response = await client.responses.create(
      { model, input: systemPrompt },
      { timeout: COMPLETION_TIMEOUT_MS, maxRetries: 0 }
    );
    console.info(`llm/router: OpenAI completion (${model}) took ${Date.now() - startedAt}ms`);
    return { model, text: response.output_text ?? '' };
  } catch (error) {
    console.error(`llm/router: OpenAI completion (${model}) failed after ${Date.now() - startedAt}ms: ${error.message}`);
    throw error;
  }
}

export async function callNvidia(systemPrompt) {
  const client = getNvidiaClient();
  if (!client) throw new Error('NVIDIA_API_KEY/NVIDIA_BASE_URL are not configured');
  const model = process.env.NVIDIA_MODEL || DEFAULT_NVIDIA_MODEL;

  const startedAt = Date.now();
  try {
    const response = await client.chat.completions.create(
      {
        model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: 'Return the JSON now.' }],
      },
      { timeout: COMPLETION_TIMEOUT_MS, maxRetries: 0 }
    );
    console.info(`llm/router: NVIDIA completion (${model}) took ${Date.now() - startedAt}ms`);
    return { model, text: response.choices?.[0]?.message?.content ?? '' };
  } catch (error) {
    console.error(`llm/router: NVIDIA completion (${model}) failed after ${Date.now() - startedAt}ms: ${error.message}`);
    throw error;
  }
}

// ---------------------------------------------------------------------
// "Your Own Model" -- a per-user, self-supplied API endpoint (product spec:
// additive third AI option, entirely separate from Model 1/Model 2 above,
// neither of which this section touches). NVIDIA's own hosted endpoint
// (getNvidiaClient above) is itself just an OpenAI-Chat-Completions-
// compatible API under a different base URL/key -- the same standard this
// section targets is already proven to work for one of the two existing
// providers, which is why Chat Completions (not the newer, OpenAI-only
// Responses API callOpenAi uses) is the right generic target here: it's
// the broadly-adopted standard self-hosted/third-party OpenAI-compatible
// endpoints (Ollama, vLLM, LM Studio, OpenRouter, Together, Groq, etc.)
// actually implement.
//
// The product spec explicitly forbids asking the user to name a model, so
// there is no user-supplied model id to send. Every OpenAI-compatible
// server also implements GET /models -- used here both to verify the
// base URL/key actually work (Test Connection) and to discover a model id
// to use for real calls, persisted on the account (see
// ownApiService.saveOwnApiConfig) rather than re-discovered on every
// request.
// ---------------------------------------------------------------------
const OWN_API_TEST_TIMEOUT_MS = 15_000;

// testOwnApiConnection({ baseUrl, apiKey }) -- returns { ok, model } on
// success (model is the first id GET /models returned, for the caller to
// persist), or { ok: false, reason } on failure. Never throws -- a bad
// URL/key is an expected, normal outcome here, not an exceptional one.
export async function testOwnApiConnection({ baseUrl, apiKey }) {
  if (!baseUrl || !apiKey) {
    return { ok: false, reason: 'API Base URL and API Key are both required.' };
  }
  let client;
  try {
    client = new OpenAI({ apiKey, baseURL: baseUrl, timeout: OWN_API_TEST_TIMEOUT_MS, maxRetries: 0 });
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  try {
    const list = await client.models.list();
    const models = list.data ?? [];
    if (models.length === 0) {
      return { ok: false, reason: 'The API responded, but listed no available models.' };
    }
    return { ok: true, model: models[0].id };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// callOwnApi(systemPrompt, { baseUrl, apiKey, model }) -- same call shape
// (systemPrompt in, { model, text } out) as callOpenAi/callNvidia above, so
// ddcAiClassifier.classifyWithAi's callModel override (see routes/ddc.js)
// can use whichever of the three interchangeably.
export async function callOwnApi(systemPrompt, { baseUrl, apiKey, model }) {
  if (!baseUrl || !apiKey) throw new Error('Your Own Model is not configured');
  if (!model) throw new Error('Your Own Model has no usable model id -- test the connection again');

  const client = new OpenAI({ apiKey, baseURL: baseUrl, timeout: CLIENT_TIMEOUT_MS, maxRetries: 1 });
  const startedAt = Date.now();
  try {
    const response = await client.chat.completions.create(
      {
        model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: 'Return the JSON now.' }],
      },
      { timeout: COMPLETION_TIMEOUT_MS, maxRetries: 0 }
    );
    console.info(`llm/router: Own API completion (${model}) took ${Date.now() - startedAt}ms`);
    return { model, text: response.choices?.[0]?.message?.content ?? '' };
  } catch (error) {
    console.error(`llm/router: Own API completion (${model}) failed after ${Date.now() - startedAt}ms: ${error.message}`);
    throw error;
  }
}

// draftFields({ skeleton, fieldsNeeded, normalizedBiblioData, ruleProfile,
// provider }) -- drafts the MARC fields marcBuilder.js's buildSkeleton()
// left in fields_needing_llm (082, 1xx, 6xx, 520, 7xx). provider is
// 'openai' (default) or 'nvidia'.
//
// Before drafting 082, queries ddcLookup.findCandidateDdcNumbers() with
// keywords derived from the book's title/subjects/description and injects
// the results into the system prompt for whichever provider is used, so
// the model picks from real DDC 23 index entries instead of inventing a
// number from memory. Falls back to letting the model draft from its own
// knowledge only when the lookup returns zero candidates, always forcing
// confidence: "low" in that case.
export async function draftFields({ skeleton, fieldsNeeded, normalizedBiblioData, ruleProfile, provider = 'openai' }) {
  if (!fieldsNeeded || fieldsNeeded.length === 0) {
    return { fields: [], systemPrompt: null, ddcCandidates: [], provider, model: null };
  }

  let ddcCandidates = [];
  if (fieldsNeeded.includes('082')) {
    const keywords = deriveDdcKeywords(normalizedBiblioData);
    // Dynamic import: ddcLookup.js touches the Postgres pool at module load
    // (db/index.js constructs it eagerly), which would otherwise make
    // *every* consumer of this file's other exports (callOpenAi, callNvidia,
    // extractJson, deriveDdcKeywords -- none of which need a database)
    // impossible to import without DATABASE_URL set. Deferring the import
    // to here, where a DB lookup is actually about to happen, keeps that
    // failure scoped to just this DDC-candidate-grounding step.
    const { findCandidateDdcNumbers } = await import('../services/ddcLookup.js');
    ddcCandidates = await findCandidateDdcNumbers(keywords);
  }

  const systemPrompt = await buildSystemPrompt({ skeleton, fieldsNeeded, normalizedBiblioData, ruleProfile, ddcCandidates });

  const call = provider === 'nvidia' ? callNvidia : callOpenAi;
  const { model, text } = await call(systemPrompt);

  let parsed;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (error) {
    throw new Error(`draftFields: could not parse ${provider} response as JSON: ${error.message}`);
  }

  return {
    fields: parsed.fields ?? [],
    systemPrompt,
    ddcCandidates,
    provider,
    model,
  };
}
