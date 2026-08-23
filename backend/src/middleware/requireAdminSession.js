import crypto from 'crypto';
import { parseCookie, stringifySetCookie } from 'cookie';

export const ADMIN_COOKIE_NAME = 'autocat_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Stateless signed cookie, not a DB-backed session row like the extension's
// bearer-token sessions table -- there's exactly one admin, authenticated
// by a single shared ADMIN_PASSWORD, so there's no per-admin identity worth
// persisting server-side. The cookie's payload is just its own expiry
// timestamp, HMAC-signed with ADMIN_SESSION_SECRET so it can't be forged or
// extended by tampering with the value.
function sign(payload) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) {
    throw new Error('ADMIN_SESSION_SECRET is not configured');
  }
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function assertAdminSecretsConfigured() {
  if (!process.env.ADMIN_PASSWORD) {
    const error = new Error('ADMIN_PASSWORD is not configured');
    error.code = 'ADMIN_PASSWORD_MISSING';
    throw error;
  }
  if (!process.env.ADMIN_SESSION_SECRET) {
    const error = new Error('ADMIN_SESSION_SECRET is not configured');
    error.code = 'ADMIN_SESSION_SECRET_MISSING';
    throw error;
  }
}

export function createAdminSessionCookie() {
  assertAdminSecretsConfigured();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = String(expiresAt);
  const value = `${payload}.${sign(payload)}`;

  return stringifySetCookie({
    name: ADMIN_COOKIE_NAME,
    value,
    httpOnly: true,
    // Render terminates TLS at the edge (Cloudflare), so the browser sees
    // HTTPS even though the Node process itself is plain HTTP. Secure cookies
    // are required in production or browsers will silently drop the session.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/admin',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearAdminSessionCookie() {
  return stringifySetCookie({
    name: ADMIN_COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/admin',
    maxAge: 0,
  });
}

function isValidAdminSessionValue(value) {
  if (!value) return false;
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return false;

  let expected;
  try {
    expected = sign(payload);
  } catch {
    return false;
  }

  const signatureBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (signatureBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(signatureBuf, expectedBuf)) {
    return false;
  }

  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export function hasValidAdminSession(req) {
  const cookies = parseCookie(req.headers.cookie || '');
  return isValidAdminSessionValue(cookies[ADMIN_COOKIE_NAME]);
}

export function requireAdminSession(req, res, next) {
  if (!hasValidAdminSession(req)) {
    // A human admin who just isn't logged in yet gets sent to the login
    // page (normal dashboard UX). A caller presenting a librarian bearer
    // token, or explicitly asking for JSON, is an API-style request (e.g.
    // a librarian session, or a security test, hitting an admin endpoint)
    // -- it gets a hard 403, never a redirect a script would just follow
    // into an HTML login page and treat as "success". Admin authorization
    // is never satisfied by a librarian's session token: the two systems
    // are entirely separate credentials (product spec section 6/14).
    const looksLikeApiCaller = Boolean(req.headers.authorization) || /application\/json/i.test(req.headers.accept || '');
    if (looksLikeApiCaller) {
      return res.status(403).json({ error: 'Admin authorization required', error_class: 'authorization_error' });
    }
    return res.redirect('/admin/login');
  }
  next();
}
