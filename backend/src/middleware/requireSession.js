import pool from '../db/index.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export const requireSession = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const { rows } = await pool.query(
    `SELECT s.token, s.expires_at, u.id AS user_id, u.institution_id, u.subscription_tier
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1`,
    [token]
  );

  const session = rows[0];

  if (!session || new Date(session.expires_at) < new Date()) {
    return res.status(401).json({ error: 'Session missing or expired' });
  }

  await pool.query('UPDATE sessions SET last_seen_at = now() WHERE token = $1', [token]);

  req.user = {
    userId: session.user_id,
    institutionId: session.institution_id,
    subscriptionTier: session.subscription_tier,
  };
  req.sessionToken = token;

  next();
});
