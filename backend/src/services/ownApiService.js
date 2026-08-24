// "Your Own Model" -- per-user self-supplied OpenAI-compatible API config.
// This module is the ONLY place own_api_configs is read or written.
//
// Two very different return shapes on purpose:
//   - getOwnApiConfig(userId): includes the DECRYPTED api key -- internal
//     use only, called exclusively from the DDC AI call site (routes/ddc.js)
//     to actually reach the user's endpoint. NEVER pass this object (or its
//     .apiKey) into an HTTP response.
//   - getOwnApiStatus(userId): client/admin-safe -- base URL + a masked key
//     + test status. No plaintext key, ever.
import pool from '../db/index.js';
import { encryptSecret, decryptSecret } from './ownApiCrypto.js';

function last4(key) {
  const clean = String(key ?? '').trim();
  return clean.length > 4 ? clean.slice(-4) : null;
}

function maskedKey(last4Value) {
  return last4Value ? `••••••••••••${last4Value}` : '••••••••••••';
}

// saveOwnApiConfig -- upserts base URL + (newly encrypted) key + the model
// id discovered from the endpoint's own /models listing at test time
// (see llm/router.js's testOwnApiConnection -- the product spec forbids
// asking the user to name a model, so this is the one place a usable model
// id ever gets attached to the account).
export async function saveOwnApiConfig(userId, baseUrl, apiKey, discoveredModel) {
  const encrypted = encryptSecret(apiKey);
  await pool.query(
    `INSERT INTO own_api_configs (user_id, base_url, api_key_encrypted, api_key_last4, discovered_model, last_test_status, last_test_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'success', now(), now())
     ON CONFLICT (user_id) DO UPDATE SET
       base_url = EXCLUDED.base_url,
       api_key_encrypted = EXCLUDED.api_key_encrypted,
       api_key_last4 = EXCLUDED.api_key_last4,
       discovered_model = EXCLUDED.discovered_model,
       last_test_status = 'success',
       last_test_at = now(),
       updated_at = now()`,
    [userId, baseUrl, encrypted, last4(apiKey), discoveredModel ?? null]
  );
}

// getOwnApiConfig -- INTERNAL USE ONLY. Returns null when the user hasn't
// configured (or has deleted) their own API.
export async function getOwnApiConfig(userId) {
  const { rows } = await pool.query(
    `SELECT base_url, api_key_encrypted, discovered_model FROM own_api_configs WHERE user_id = $1`,
    [userId]
  );
  const row = rows[0];
  if (!row) return null;
  return { baseUrl: row.base_url, apiKey: decryptSecret(row.api_key_encrypted), model: row.discovered_model };
}

// getOwnApiStatus -- safe to send to the extension (settings screen) or use
// in admin rendering. `configured` is what the admin Users page needs;
// base_url/api_key_masked/last_test_* are what the extension's own settings
// screen redisplays after a page reload.
export async function getOwnApiStatus(userId) {
  const { rows } = await pool.query(
    `SELECT base_url, api_key_last4, last_test_status, last_test_at FROM own_api_configs WHERE user_id = $1`,
    [userId]
  );
  const row = rows[0];
  if (!row) return { configured: false, base_url: null, api_key_masked: null, last_test_status: null, last_test_at: null };
  return {
    configured: true,
    base_url: row.base_url,
    api_key_masked: maskedKey(row.api_key_last4),
    last_test_status: row.last_test_status,
    last_test_at: row.last_test_at,
  };
}

export async function deleteOwnApiConfig(userId) {
  await pool.query('DELETE FROM own_api_configs WHERE user_id = $1', [userId]);
}
