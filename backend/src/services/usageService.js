// Real per-request AI usage tracking -- the single place every AI-touching
// endpoint (DDC recommend/re-analyze today; ISBN's web-search fallback;
// anything AI-driven added later) logs what actually happened, so the admin
// Usage page reflects real backend activity rather than a frontend guess.
//
// Previously only the ISBN web-search fallback ever wrote to api_usage,
// under a `provider` column that actually held a model name -- the DDC
// classification pipeline (by far the more common AI call) never recorded
// anything at all. recordUsage() is the fix: every caller passes the real
// provider ('nvidia' | 'openai'), the model name, what kind of request it
// was, and whether it succeeded.
import pool from '../db/index.js';

// 'own' -- "Your Own Model" usage (product spec: tracked separately from,
// never mixed into, the existing NVIDIA/OpenAI figures -- see
// usageSummary's ownRequests below).
const KNOWN_PROVIDERS = new Set(['nvidia', 'openai', 'own']);
const KNOWN_STATUSES = new Set(['success', 'failure']);

// Never throws -- a logging failure must never break the AI request it's
// describing. Swallows and logs to stderr instead.
//
// isbn -- which book this request was for (product spec: every AI/API call
// made as part of an ISBN workflow -- lookup, DDC, MARC generation, Ask
// AutoCat with an active book -- must carry the ISBN through to the usage
// log). Optional/null: a request genuinely not tied to a book (e.g. Ask
// AutoCat with nothing loaded yet) legitimately has none -- never fabricated.
export async function recordUsage({ userId, isbn = null, provider, model, requestType, tokensUsed = null, status = 'success', durationMs = null }) {
  try {
    await pool.query(
      `INSERT INTO api_usage (user_id, isbn, provider, model, request_type, tokens_used, status, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId ?? null, isbn ?? null, provider, model ?? null, requestType, tokensUsed, status, durationMs ?? null]
    );
  } catch (error) {
    console.error(`usageService.recordUsage failed (provider=${provider}, requestType=${requestType}): ${error.message}`);
  }
}

// Same normalization isbnLookup.js's normalizeIsbn uses -- strips hyphens/
// spaces so "978-1-032-76922-6" and "9781032769226" match the same rows,
// without needing a second normalized column.
function normalizeIsbnFilter(value) {
  const stripped = String(value ?? '').replace(/[-\s]/g, '').trim();
  return stripped || undefined;
}

function buildFilterConditions({ userId, isbn, provider, status, since, until }) {
  const conditions = [];
  const values = [];
  let i = 1;
  if (userId) {
    conditions.push(`au.user_id = $${i++}`);
    values.push(userId);
  }
  const normalizedIsbn = normalizeIsbnFilter(isbn);
  if (normalizedIsbn) {
    conditions.push(`au.isbn = $${i++}`);
    values.push(normalizedIsbn);
  }
  if (provider && KNOWN_PROVIDERS.has(provider)) {
    conditions.push(`au.provider = $${i++}`);
    values.push(provider);
  }
  if (status && KNOWN_STATUSES.has(status)) {
    conditions.push(`au.status = $${i++}`);
    values.push(status);
  }
  if (since) {
    conditions.push(`au.created_at >= $${i++}`);
    values.push(since);
  }
  if (until) {
    conditions.push(`au.created_at <= $${i++}`);
    values.push(until);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values, nextIndex: i };
}

// listUsage -- the admin Usage page's "live activity" feed, newest first.
// All filters optional; an unrecognized provider/status value is ignored
// rather than erroring, so a stray query param can't 500 the page.
export async function listUsage({ userId, isbn, provider, status, since, until, limit = 100 } = {}) {
  const { where, values, nextIndex } = buildFilterConditions({ userId, isbn, provider, status, since, until });
  values.push(Math.min(Number(limit) || 100, 500));

  const { rows } = await pool.query(
    `SELECT au.id, au.user_id, u.email, u.autocat_user_id, au.isbn, au.provider, au.model,
            au.request_type, au.tokens_used, au.status, au.duration_ms, au.created_at
     FROM api_usage au
     LEFT JOIN users u ON u.id = au.user_id
     ${where}
     ORDER BY au.created_at DESC
     LIMIT $${nextIndex}`,
    values
  );
  return rows;
}

// usageSummary -- the four summary cards (total / NVIDIA / OpenAI / active
// users) for the admin Usage page, honoring the same filters as listUsage
// (minus limit) so the cards match whatever the activity feed below them is
// currently showing.
export async function usageSummary({ userId, isbn, provider, status, since, until } = {}) {
  const { where, values } = buildFilterConditions({ userId, isbn, provider, status, since, until });

  const [{ rows: byProvider }, { rows: activeUsers }] = await Promise.all([
    pool.query(`SELECT au.provider, count(*) AS count FROM api_usage au ${where} GROUP BY au.provider`, values),
    pool.query(
      `SELECT count(DISTINCT au.user_id) AS count FROM api_usage au ${where ? `${where} AND` : 'WHERE'} au.user_id IS NOT NULL`,
      values
    ),
  ]);

  const totalRequests = byProvider.reduce((sum, row) => sum + Number(row.count), 0);
  return {
    totalRequests,
    nvidiaRequests: Number(byProvider.find((r) => r.provider === 'nvidia')?.count ?? 0),
    openaiRequests: Number(byProvider.find((r) => r.provider === 'openai')?.count ?? 0),
    ownRequests: Number(byProvider.find((r) => r.provider === 'own')?.count ?? 0),
    activeUsers: Number(activeUsers[0]?.count ?? 0),
  };
}

// usageOverviewStats -- today's real operational counts for the admin
// Overview dashboard (product spec item 16: replace the old "MARC records
// stored" tile, which measured a cataloguing-history database AutoCat no
// longer keeps, with genuine usage-log-derived activity figures instead).
export async function usageOverviewStats() {
  const { rows } = await pool.query(
    `SELECT
       count(*) AS api_calls_today,
       count(DISTINCT isbn) FILTER (WHERE isbn IS NOT NULL) AS isbns_processed_today,
       count(*) FILTER (WHERE status = 'success') AS success_today,
       count(*) FILTER (WHERE status = 'failure') AS failed_today
     FROM api_usage
     WHERE created_at >= date_trunc('day', now())`
  );
  const row = rows[0] ?? {};
  return {
    apiCallsToday: Number(row.api_calls_today ?? 0),
    isbnsProcessedToday: Number(row.isbns_processed_today ?? 0),
    successToday: Number(row.success_today ?? 0),
    failedToday: Number(row.failed_today ?? 0),
  };
}

// listUsageUsers -- populates the admin Usage page's user filter dropdown
// with only accounts that have actually made a logged request (not every
// registered user).
export async function listUsageUsers() {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id, u.email, u.autocat_user_id
     FROM api_usage au
     JOIN users u ON u.id = au.user_id
     ORDER BY u.email`
  );
  return rows;
}
