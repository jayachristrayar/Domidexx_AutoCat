import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { Router } from 'express';
import { z } from 'zod';
import pool from '../db/index.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireSession } from '../middleware/requireSession.js';
import {
  createUser,
  accountAccessError,
  UserAlreadyExistsError,
} from '../services/userService.js';

const router = Router();

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function readDeviceId(req, bodyDeviceId) {
  const header = req.headers['x-device-id'];
  const raw = bodyDeviceId || (typeof header === 'string' ? header : '');
  const cleaned = String(raw || '').trim().slice(0, 128);
  return cleaned || null;
}

async function createSession(userId, deviceId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await pool.query(
    'INSERT INTO sessions (token, user_id, device_id, expires_at) VALUES ($1, $2, $3, $4)',
    [token, userId, deviceId, expiresAt]
  );

  return token;
}

// Enforce max concurrent devices. Same device_id reuses/replaces its own
// sessions. When at the limit, the oldest other-device session is dropped.
async function enforceDeviceLimit(userId, deviceLimit, deviceId) {
  if (!deviceLimit || deviceLimit < 1) return;

  if (deviceId) {
    await pool.query('DELETE FROM sessions WHERE user_id = $1 AND device_id = $2', [userId, deviceId]);
  }

  const { rows } = await pool.query(
    `SELECT COALESCE(device_id, 'token:' || token) AS device_key,
            ARRAY_AGG(token) AS tokens,
            MAX(last_seen_at) AS last_seen
     FROM sessions
     WHERE user_id = $1 AND expires_at > now()
     GROUP BY COALESCE(device_id, 'token:' || token)
     ORDER BY MAX(last_seen_at) ASC`,
    [userId]
  );

  const overflow = rows.length - (deviceLimit - 1);
  if (overflow <= 0) return;

  for (const row of rows.slice(0, overflow)) {
    await pool.query('DELETE FROM sessions WHERE token = ANY($1::text[])', [row.tokens]);
  }
}

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  institution_slug: z.string().min(1),
  device_id: z.string().min(1).max(128).optional(),
});

// Contact address for activation requests -- shown to the librarian after
// signup and on a pending/inactive login attempt. A single constant so the
// address only needs to change in one place.
const ACTIVATION_CONTACT_EMAIL = 'team.domidexx@gmail.com';

router.post(
  '/signup',
  asyncHandler(async (req, res) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { email, password, institution_slug: institutionSlug } = parsed.data;

    // A librarian must never get an immediately-usable account just by
    // submitting this form (product spec section 1): the account is
    // created, but PENDING -- no session is issued, so there is nothing
    // for the extension to even be logged in WITH until an administrator
    // approves it via the admin dashboard.
    try {
      await createUser({ email, password, institutionSlug, status: 'PENDING' });
    } catch (error) {
      if (error instanceof UserAlreadyExistsError) {
        return res.status(400).json({ error: 'Email already registered' });
      }
      throw error;
    }

    res.status(201).json({
      status: 'PENDING',
      message: 'Account created successfully. Your account is currently pending activation by an administrator. Please contact the AutoCat team to request credential activation.',
      contact_email: ACTIVATION_CONTACT_EMAIL,
    });
  })
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  device_id: z.string().min(1).max(128).optional(),
});

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { email, password, device_id: bodyDeviceId } = parsed.data;
    const deviceId = readDeviceId(req, bodyDeviceId);

    const result = await pool.query(
      `SELECT id, password_hash, is_active, status, device_limit, expires_at
       FROM users WHERE email = $1`,
      [email]
    );
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Authentication (password matched) proved above; authorization (is
    // this account currently allowed to use AutoCat?) is a separate check
    // -- a correct password on a PENDING/REJECTED/DISABLED account must
    // still never issue a session.
    const accessError = accountAccessError(user);
    if (accessError) {
      return res.status(403).json({ error: accessError.message, error_class: 'authorization_error', status: user.status });
    }

    await enforceDeviceLimit(user.id, user.device_limit, deviceId);
    const token = await createSession(user.id, deviceId);
    res.json({ token });
  })
);

router.post(
  '/logout',
  requireSession,
  asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM sessions WHERE token = $1', [req.sessionToken]);
    res.status(204).end();
  })
);

export default router;
