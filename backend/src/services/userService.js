import bcrypt from 'bcrypt';
import pool from '../db/index.js';

const SALT_ROUNDS = 12;

export class UserAlreadyExistsError extends Error {}
export class UserNotFoundError extends Error {}

function institutionNameFromSlug(slug) {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

// createUser -- shared by POST /auth/signup (public signup, always 'free')
// and the admin dashboard's "Create user" form (POST /admin/users, which
// can set the tier directly). Institutions are looked up or created by
// slug purely as a grouping/reporting label, per the shared-rules
// architecture -- it does not select which cataloguing rules apply.
export async function createUser({ email, password, institutionSlug, subscriptionTier = 'free' }) {
  const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existingUser.rows.length > 0) {
    throw new UserAlreadyExistsError('Email already registered');
  }

  const existingInstitution = await pool.query('SELECT id FROM institutions WHERE slug = $1', [institutionSlug]);

  let institutionId;
  if (existingInstitution.rows.length > 0) {
    institutionId = existingInstitution.rows[0].id;
  } else {
    const insertedInstitution = await pool.query(
      'INSERT INTO institutions (slug, name) VALUES ($1, $2) RETURNING id',
      [institutionSlug, institutionNameFromSlug(institutionSlug)]
    );
    institutionId = insertedInstitution.rows[0].id;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const insertedUser = await pool.query(
    'INSERT INTO users (email, password_hash, institution_id, subscription_tier) VALUES ($1, $2, $3, $4) RETURNING id',
    [email, passwordHash, institutionId, subscriptionTier]
  );

  return { userId: insertedUser.rows[0].id, institutionId };
}

// Admin-initiated password reset for a library user. Updates the hash and
// clears all extension sessions so old tokens cannot keep working.
export async function resetUserPassword(userId, password) {
  const existing = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
  if (existing.rows.length === 0) {
    throw new UserNotFoundError('User not found');
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  return { userId };
}
