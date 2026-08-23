import pool from '../db/index.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { accountAccessError } from '../services/userService.js';

export const requireSession = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const { rows } = await pool.query(
    `SELECT s.token, s.expires_at, s.device_id,
            u.id AS user_id, u.institution_id, u.subscription_tier,
            u.autocat_user_id, u.model_access,
            u.is_active, u.status, u.expires_at AS account_expires_at, u.device_limit
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1`,
    [token]
  );

  const session = rows[0];

  if (!session || new Date(session.expires_at) < new Date()) {
    return res.status(401).json({ error: 'Session missing or expired' });
  }

  // Re-checked on EVERY protected request, not just at login: never trust
  // the browser/extension to have decided the account is still authorized
  // (product spec section 5/15) -- an admin revoking access takes effect
  // on this account's very next API call, not just its next login.
  const accessError = accountAccessError({
    is_active: session.is_active,
    status: session.status,
    expires_at: session.account_expires_at,
  });
  if (accessError) {
    await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    return res.status(403).json({ error: accessError.message, error_class: 'authorization_error', status: session.status });
  }

  await pool.query('UPDATE sessions SET last_seen_at = now() WHERE token = $1', [token]);

  req.user = {
    userId: session.user_id,
    institutionId: session.institution_id,
    subscriptionTier: session.subscription_tier,
    autocatUserId: session.autocat_user_id,
    modelAccess: session.model_access,
    deviceLimit: session.device_limit,
    deviceId: session.device_id,
  };
  req.sessionToken = token;

  next();
});
