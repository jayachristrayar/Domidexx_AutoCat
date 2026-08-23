import OpenAI from 'openai';

const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 5 * 60 * 1000;

// OpenAI's /v1/models response does not expose a capabilities flag for the
// Responses API or the web_search tool (id, created, object, owned_by,
// shutdown_date only -- confirmed against the current API docs and the SDK's
// own Model type as of writing). So model selection has to go by naming
// convention rather than a queryable capability, which is what OpenAI's own
// docs point to as well. This list is a family/priority order, not a full
// model id: any model id that STARTS WITH one of these prefixes is treated
// as a Responses-API + web_search-capable candidate, ranked in the order
// given (best/newest family first per OpenAI's current docs). Adding a
// brand-new model *family* still needs a prefix added here; a new dated
// snapshot or point release within an existing family (e.g. a new gpt-5.x)
// is already picked up automatically by the "newest `created` wins within a
// family" rule below and the scheduled refresh, with no code change.
const CANDIDATE_FAMILY_PREFIXES = ['gpt-5', 'gpt-4.1', 'gpt-4o', 'o4', 'o3'];

// Model ids that match a candidate prefix above but are known not to be
// general Responses-API chat/web_search models (deprecated search-preview
// variants, fine-tune/instruct variants, etc).
const EXCLUDE_PATTERN = /(search-preview|instruct|realtime|audio|transcribe)/i;

let client = null;
let cachedModel = null;
let cachedAt = 0;
let refreshPromise = null;
let refreshTimer = null;

// The SDK's own default timeout is 10 minutes -- far longer than any
// realistic HTTP request should stay open, and long enough to exceed most
// hosting platforms' own proxy timeout before this app ever gets a chance
// to respond with a real error. That silent platform-level cutoff -- not
// this app's own error handling -- is what produces a bare, undiagnosable
// "AutoCat service is temporarily unavailable" on the client: the request
// just dies with no body for server.js's error handler to ever log. This is
// a backstop; individual call sites pass their own (shorter) per-request
// timeout for their specific latency budget (see llm/router.js,
// isbnLookup.js) -- see product spec item 17, "separate time limits per
// stage", not one timeout for everything.
const CLIENT_TIMEOUT_MS = 55_000;

function getOpenAiClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
      timeout: CLIENT_TIMEOUT_MS,
      maxRetries: 1,
    });
  }
  return client;
}

function pickBestModel(models) {
  const eligible = models.filter(
    (model) => typeof model.id === 'string' && !EXCLUDE_PATTERN.test(model.id)
  );

  for (const prefix of CANDIDATE_FAMILY_PREFIXES) {
    const matches = eligible.filter((model) => model.id.startsWith(prefix));
    if (matches.length === 0) continue;
    matches.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    return matches[0].id;
  }

  return null;
}

async function refreshModel() {
  const openai = getOpenAiClient();
  if (!openai) {
    console.error('OpenAI model selection: OPENAI_API_KEY is not set; web-search fallback is disabled.');
    cachedModel = null;
    cachedAt = Date.now();
    return null;
  }

  try {
    const list = await openai.models.list();
    const chosen = pickBestModel(list.data ?? []);
    if (!chosen) {
      console.error(
        'OpenAI model selection: no Responses-API/web_search-capable model found for this API key.'
      );
    }
    cachedModel = chosen;
    cachedAt = Date.now();
    return chosen;
  } catch (error) {
    console.error(`OpenAI model selection: failed to list models: ${error.message}`);
    cachedModel = null;
    cachedAt = Date.now();
    return null;
  }
}

export async function getAvailableOpenAiModel() {
  const ttl = cachedModel ? SUCCESS_TTL_MS : FAILURE_RETRY_MS;
  if (cachedAt && Date.now() - cachedAt < ttl) {
    return cachedModel;
  }
  if (!refreshPromise) {
    refreshPromise = refreshModel().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function forceRefreshModel() {
  if (!refreshPromise) {
    refreshPromise = refreshModel().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export function startModelRefreshSchedule() {
  getAvailableOpenAiModel().catch(() => {});
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    forceRefreshModel().catch((error) => {
      console.error(`OpenAI model selection: scheduled refresh failed: ${error.message}`);
    });
  }, SUCCESS_TTL_MS);
  refreshTimer.unref?.();
}

export function getOpenAiClientForFallback() {
  return getOpenAiClient();
}
