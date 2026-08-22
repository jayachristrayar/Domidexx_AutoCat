import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { Router } from 'express';
import { z } from 'zod';
import pool from '../db/index.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireSession } from '../middleware/requireSession.js';
import { createUser, UserAlreadyExistsError } from '../services/userService.js';

const router = Router();

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await pool.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [
    token,
    userId,
    expiresAt,
  ]);

  return token;
}

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  institution_slug: z.string().min(1),
});

router.post(
  '/signup',
  asyncHandler(async (req, res) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { email, password, institution_slug: institutionSlug } = parsed.data;

    let userId;
    try {
      ({ userId } = await createUser({ email, password, institutionSlug }));
    } catch (error) {
      if (error instanceof UserAlreadyExistsError) {
        return res.status(400).json({ error: 'Email already registered' });
      }
      throw error;
    }

    const token = await createSession(userId);

    res.status(201).json({ token });
  })
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;

    const result = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = await createSession(user.id);

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
