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

const KNOWN_PROVIDERS = new Set(['nvidia', 'openai']);
const KNOWN_STATUSES = new Set(['success', 'failure']);

// Never throws -- a logging failure must never break the AI request it's
// describing. Swallows and logs to stderr instead.
export async function recordUsage({ userId, provider, model, requestType, tokensUsed = null, status = 'success' }) {
  try {
    await pool.query(
      `INSERT INTO api_usage (user_id, provider, model, request_type, tokens_used, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId ?? null, provider, model ?? null, requestType, tokensUsed, status]
    );
  } catch (error) {
    console.error(`usageService.recordUsage failed (provider=${provider}, requestType=${requestType}): ${error.message}`);
  }
}

function buildFilterConditions({ userId, provider, status, since, until }) {
  const conditions = [];
  const values = [];
  let i = 1;
  if (userId) {
    conditions.push(`au.user_id = $${i++}`);
    values.push(userId);
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
export async function listUsage({ userId, provider, status, since, until, limit = 100 } = {}) {
  const { where, values, nextIndex } = buildFilterConditions({ userId, provider, status, since, until });
  values.push(Math.min(Number(limit) || 100, 500));

  const { rows } = await pool.query(
    `SELECT au.id, au.user_id, u.email, u.autocat_user_id, au.provider, au.model,
            au.request_type, au.tokens_used, au.status, au.created_at
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
export async function usageSummary({ userId, provider, status, since, until } = {}) {
  const { where, values } = buildFilterConditions({ userId, provider, status, since, until });

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
    activeUsers: Number(activeUsers[0]?.count ?? 0),
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
