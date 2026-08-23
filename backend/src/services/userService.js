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

// createUser -- shared by POST /auth/signup (public signup: always 'free'
// tier, and always created with status 'PENDING' -- a librarian must never
// get an immediately-usable account just by submitting the signup form)
// and the admin dashboard's "Create user" form (POST /admin/users, an
// admin directly provisioning an account, so it defaults to already
// ACTIVE -- callers pass status explicitly either way, this default only
// covers the admin-dashboard call site). Institutions are looked up or
// created by slug purely as a grouping/reporting label, per the
// shared-rules architecture -- it does not select which cataloguing rules
// apply.
export async function createUser({
  email,
  password,
  institutionSlug,
  subscriptionTier = 'free',
  status = 'ACTIVE',
  deviceLimit = 2,
  expiresAt = null,
}) {
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
  // is_active kept in sync with status here too, purely for the existing
  // admin-UI badge/backward-compat reads -- status is the field every
  // access-control check (accountAccessError) actually relies on.
  const isActive = status === 'ACTIVE';

  const insertedUser = await pool.query(
    `INSERT INTO users (
       email, password_hash, institution_id, subscription_tier,
       is_active, status, device_limit, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [email, passwordHash, institutionId, subscriptionTier, isActive, status, deviceLimit, expiresAt]
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

// setUserActive -- the pre-existing activate/deactivate toggle (still used
// by the admin dashboard's Activate/Deactivate button for accounts already
// past the initial PENDING approval step). Keeps status in sync: activating
// sets ACTIVE, deactivating sets DISABLED (never silently leaves an account
// looking PENDING again -- that would misrepresent "never approved yet" as
// "approved, then deactivated").
export async function setUserActive(userId, isActive) {
  const result = await pool.query('UPDATE users SET is_active = $1, status = $2 WHERE id = $3 RETURNING id', [
    isActive,
    isActive ? 'ACTIVE' : 'DISABLED',
    userId,
  ]);
  if (result.rows.length === 0) {
    throw new UserNotFoundError('User not found');
  }
  if (!isActive) {
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }
  return { userId };
}

const VALID_STATUSES = new Set(['PENDING', 'ACTIVE', 'REJECTED', 'DISABLED']);

// setUserStatus -- the general activation-workflow transition backing the
// admin dashboard's Approve / Reject / Disable / Reactivate actions.
// Revoking access (anything but ACTIVE) always clears existing sessions,
// so a change takes effect immediately rather than waiting for the next
// requireSession check to catch up on an already-issued token.
export async function setUserStatus(userId, status) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid user status: ${status}`);
  }
  const result = await pool.query('UPDATE users SET status = $1, is_active = $2 WHERE id = $3 RETURNING id', [
    status,
    status === 'ACTIVE',
    userId,
  ]);
  if (result.rows.length === 0) {
    throw new UserNotFoundError('User not found');
  }
  if (status !== 'ACTIVE') {
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }
  return { userId, status };
}

// setModelAccess -- the only place users.model_access is ever written.
// Called exclusively from the admin dashboard (admin.js); a librarian's own
// session can never reach this (there is no user-facing route that calls
// it) -- section 8/18's "only an administrator can grant/revoke OpenAI
// access, never the account itself" is enforced by there being no other
// caller, not by a runtime role check on top of it.
async function setModelAccess(userId, access) {
  const result = await pool.query('UPDATE users SET model_access = $1::text[] WHERE id = $2 RETURNING model_access', [
    access,
    userId,
  ]);
  if (result.rows.length === 0) {
    throw new UserNotFoundError('User not found');
  }
  return { userId, modelAccess: result.rows[0].model_access };
}

// NVIDIA is the permanent baseline every account gets by default (product
// spec section 4) -- there is no "disable NVIDIA" action, so both of these
// always include it regardless of the account's prior model_access value.
export function enableOpenAiAccess(userId) {
  return setModelAccess(userId, ['NVIDIA', 'OPENAI']);
}

export function disableOpenAiAccess(userId) {
  return setModelAccess(userId, ['NVIDIA']);
}

export async function updateUserAccess({ userId, deviceLimit, expiresAt }) {
  const result = await pool.query(
    `UPDATE users
     SET device_limit = COALESCE($1, device_limit),
         expires_at = $2
     WHERE id = $3
     RETURNING id`,
    [deviceLimit, expiresAt, userId]
  );
  if (result.rows.length === 0) {
    throw new UserNotFoundError('User not found');
  }
  return { userId };
}

export async function deleteUser(userId) {
  const existing = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
  if (existing.rows.length === 0) {
    throw new UserNotFoundError('User not found');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM draft_state WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM api_usage WHERE user_id = $1', [userId]);
    // Keep MARC records for audit, but detach the deleted account.
    await client.query('UPDATE marc_records SET user_id = NULL WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return { userId };
}

// Authentication (does this account/session exist and match the password?)
// is deliberately separate from authorization (is this account currently
// ALLOWED to use AutoCat?) -- accountAccessError is the single place that
// answers the second question, called both at login (auth.js) and on every
// subsequent protected request (requireSession.js), so a status change an
// admin makes takes effect immediately rather than only at next login.
// Returns { message, code } describing why access is denied, or null when
// the account is fully authorized.
export function accountAccessError(user) {
  if (!user) return { message: 'Invalid email or password', code: 'INVALID_CREDENTIALS' };
  if (user.status === 'PENDING') {
    return {
      message: 'Your account is awaiting administrator activation. Please contact team.domidexx@gmail.com if you need activation.',
      code: 'ACCOUNT_PENDING',
    };
  }
  if (user.status === 'REJECTED' || user.status === 'DISABLED' || user.is_active === false) {
    return {
      message: 'Your AutoCat account is currently inactive. Please contact the AutoCat team.',
      code: 'ACCOUNT_INACTIVE',
    };
  }
  if (user.expires_at && new Date(user.expires_at) < new Date()) {
    return { message: 'Account access period has expired. Contact your administrator.', code: 'ACCOUNT_EXPIRED' };
  }
  return null;
}
