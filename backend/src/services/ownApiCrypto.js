// AES-256-GCM encryption for "Your Own Model" API keys at rest -- the ONLY
// place a user-supplied API key is ever encrypted/decrypted. Nothing else
// in this codebase touches own_api_configs.api_key_encrypted directly (see
// ownApiService.js).
//
// Follows the same "required env var, fail loud, never invent a default"
// pattern already used for ADMIN_SESSION_SECRET (requireAdminSession.js):
// OWN_API_ENCRYPTION_KEY must be explicitly configured in production, or
// this feature refuses to run rather than silently using a guessable key.
import crypto from 'crypto';

const IV_LENGTH = 12; // recommended GCM nonce size
const AUTH_TAG_LENGTH = 16;

// Accepts the key as base64 or hex (32 raw bytes either way); if the
// operator supplies something else entirely (any length, any encoding),
// derive a 32-byte key from it via SHA-256 rather than rejecting it -- this
// keeps ADMIN_SESSION_SECRET-style "any sufficiently long random string"
// operator expectations working here too.
function getKey() {
  const raw = process.env.OWN_API_ENCRYPTION_KEY;
  if (!raw) {
    const error = new Error('OWN_API_ENCRYPTION_KEY is not configured');
    error.code = 'OWN_API_ENCRYPTION_KEY_MISSING';
    throw error;
  }
  for (const encoding of ['base64', 'hex']) {
    const buf = Buffer.from(raw, encoding);
    if (buf.length === 32) return buf;
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

export function assertOwnApiEncryptionConfigured() {
  getKey();
}

// encryptSecret(plaintext) -> base64 string encoding [iv][authTag][ciphertext]
export function encryptSecret(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

// decryptSecret(payload) -- inverse of encryptSecret. Throws if the key has
// changed or the ciphertext was tampered with (GCM auth tag mismatch) --
// never silently returns garbage.
export function decryptSecret(payload) {
  const key = getKey();
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
