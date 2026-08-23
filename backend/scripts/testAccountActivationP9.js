// Live end-to-end test of the account-activation workflow (product spec:
// a signup must never be immediately usable; only an admin-approved
// account can authenticate). Spins up a real temporary Postgres database
// and a real running backend process, then drives it with real HTTP
// requests -- same harness pattern as testUserAccess.js. Covers the
// "IMPORTANT SECURITY TESTS" list directly:
//   1. new signup -> PENDING, no session issued
//   2. pending user login -> denied, specific message, no token
//   3. admin approves -> ACTIVE
//   4. user logs in -> works, protected endpoints reachable
//   5. user attempts an admin API operation -> 403, not silently ignored
//   6/7. a forged/tampered request still can't reach protected data
//   8. disabled (rejected/deactivated) user -> cannot use AutoCat
//   9. revoking access invalidates an already-issued session immediately
//   10. existing (pre-migration) active users keep working
import assert from 'assert';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..');

function waitForOutput(child, pattern, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`timeout\n${buffer}`)), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString();
      if (pattern.test(buffer)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        resolve(buffer);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`exit ${code}\n${buffer}`));
    });
  });
}

async function withTempDatabase(run) {
  const dbName = `autocat_activation_${Date.now()}`;
  const admin = new pg.Pool({ connectionString: 'postgresql://autocat:autocat@127.0.0.1:5432/postgres', ssl: false });
  await admin.query(`CREATE DATABASE ${dbName}`);
  const databaseUrl = `postgresql://autocat:autocat@127.0.0.1:5432/${dbName}`;
  try {
    await run(databaseUrl);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
}

function check(name, condition) {
  assert.ok(condition, `FAILED: ${name}`);
  console.log(`PASS ${name}`);
}

await withTempDatabase(async (databaseUrl) => {
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    ADMIN_PASSWORD: 'test-admin-password',
    ADMIN_SESSION_SECRET: 'test-admin-session-secret-32chars',
    NODE_ENV: 'test',
    PGSSLMODE: 'disable',
    PORT: '18082',
  };

  const child = spawn(process.execPath, ['./src/server.js'], { cwd: backendRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    await waitForOutput(child, /AutoCat backend listening/);
    const base = 'http://127.0.0.1:18082';
    const jsonHeaders = { 'Content-Type': 'application/json', Origin: 'chrome-extension://t' };

    // -- Admin login (a completely separate credential from any librarian
    // account -- there is no path from a librarian session to this) -----
    const adminLoginRes = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=test-admin-password',
      redirect: 'manual',
    });
    const adminCookie = adminLoginRes.headers.get('set-cookie').split(';')[0];

    // ---------------------------------------------------------------
    // TEST 1: new signup -> PENDING, no session issued.
    // ---------------------------------------------------------------
    const signupRes = await fetch(`${base}/auth/signup`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ email: 'newlibrarian@example.com', password: 'password123', institution_slug: 'demo' }),
    });
    const signupBody = await signupRes.json();
    check('signup returns 201', signupRes.status === 201);
    check('signup response has no session token', !signupBody.token);
    check('signup response reports PENDING status', signupBody.status === 'PENDING');
    check('signup response includes the activation contact email', signupBody.contact_email === 'team.domidexx@gmail.com');
    check('signup response never claims credentials were auto-generated', !/automatically generated/i.test(signupBody.message || ''));

    // Duplicate signup still correctly rejected (pre-existing behavior).
    const dupRes = await fetch(`${base}/auth/signup`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: 'newlibrarian@example.com', password: 'password123', institution_slug: 'demo' }) });
    check('duplicate signup rejected', dupRes.status === 400);

    // ---------------------------------------------------------------
    // TEST 2: pending user login -> denied AutoCat access, no token.
    // ---------------------------------------------------------------
    const pendingLoginRes = await fetch(`${base}/auth/login`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: 'newlibrarian@example.com', password: 'password123' }) });
    const pendingLoginBody = await pendingLoginRes.json();
    check('pending user login denied with 403', pendingLoginRes.status === 403);
    check('pending user login has no token', !pendingLoginBody.token);
    check('pending user login message mentions administrator activation', /awaiting administrator activation/i.test(pendingLoginBody.error));
    check('pending user login message includes contact email', pendingLoginBody.error.includes('team.domidexx@gmail.com'));
    check('pending user login reports PENDING status', pendingLoginBody.status === 'PENDING');

    // Find the pending user's admin-dashboard row/id.
    const usersPageBeforeApproval = await (await fetch(`${base}/admin/users`, { headers: { Cookie: adminCookie } })).text();
    check('admin dashboard shows the account as pending', /Pending activation/i.test(usersPageBeforeApproval));
    const pendingUserId = usersPageBeforeApproval.match(/newlibrarian@example\.com[\s\S]*?#(\d+)/)?.[1];
    check('found pending user id in admin dashboard', Boolean(pendingUserId));

    // ---------------------------------------------------------------
    // TEST 5 (checked early, against the still-PENDING account): a
    // librarian has no credential that can reach an admin operation at
    // all -- not even an unauthenticated request gets treated as "maybe
    // an admin". No cookie, no bearer token: still a hard denial.
    // ---------------------------------------------------------------
    const noAuthAdminAttempt = await fetch(`${base}/admin/users/${pendingUserId}/approve`, {
      method: 'POST',
      headers: { Authorization: 'Bearer not-a-real-admin-credential' },
      redirect: 'manual',
    });
    check('admin API without a valid admin session is rejected', noAuthAdminAttempt.status === 403);
    const noAuthAdminBody = await noAuthAdminAttempt.json();
    check('admin API rejection does not silently succeed', noAuthAdminBody.error_class === 'authorization_error');

    // ---------------------------------------------------------------
    // TEST 3: admin approves -> ACTIVE.
    // ---------------------------------------------------------------
    const approveRes = await fetch(`${base}/admin/users/${pendingUserId}/approve`, { method: 'POST', headers: { Cookie: adminCookie }, redirect: 'manual' });
    check('approve redirects back to the users list', approveRes.status === 302 || approveRes.status === 303);
    const usersPageAfterApproval = await (await fetch(`${base}/admin/users`, { headers: { Cookie: adminCookie } })).text();
    check('admin dashboard now shows the account as Active', /badge-ok">Active/i.test(usersPageAfterApproval));

    // ---------------------------------------------------------------
    // TEST 4: user logs in -> AutoCat works (protected endpoint reachable).
    // ---------------------------------------------------------------
    const activeLoginRes = await fetch(`${base}/auth/login`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: 'newlibrarian@example.com', password: 'password123' }) });
    check('approved account can log in', activeLoginRes.status === 200);
    const { token } = await activeLoginRes.json();
    check('login issued a real session token', typeof token === 'string' && token.length > 10);

    const meRes = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${token}`, Origin: 'chrome-extension://t' } });
    check('active session can reach a protected endpoint (/me)', meRes.status === 200);
    const meBody = await meRes.json();
    check('the /me payload never mentions internal role/status implementation', meBody.status === undefined && meBody.role === undefined);

    // ---------------------------------------------------------------
    // TEST 5 (repeat, now with a REAL librarian bearer token): still no
    // access to admin operations. A valid AutoCat session is authentication,
    // not authorization for admin actions -- entirely separate credential.
    // ---------------------------------------------------------------
    const userTriesAdminApi = await fetch(`${base}/admin/users/${pendingUserId}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Origin: 'chrome-extension://t' },
      redirect: 'manual',
    });
    check('a real librarian session token cannot perform an admin operation', userTriesAdminApi.status === 403);

    // ---------------------------------------------------------------
    // TESTS 6/7: no client-side trick reaches protected data -- a
    // malformed/forged/missing Authorization header is rejected the same
    // way regardless of what the extension's local state claims.
    // ---------------------------------------------------------------
    const noAuthHeader = await fetch(`${base}/records/lookup/9780140328721`, { headers: { Origin: 'chrome-extension://t' } });
    check('protected endpoint refuses a request with no Authorization header at all', noAuthHeader.status === 401);
    const forgedToken = await fetch(`${base}/records/lookup/9780140328721`, { headers: { Authorization: 'Bearer completely-made-up-token', Origin: 'chrome-extension://t' } });
    check('protected endpoint refuses a forged/unknown session token', forgedToken.status === 401);

    // ---------------------------------------------------------------
    // TEST 9: revoking access invalidates an ALREADY-ISSUED session
    // immediately -- the backend re-checks status on every request, it
    // never trusts a token was valid just because it once was.
    // ---------------------------------------------------------------
    await fetch(`${base}/admin/users/${pendingUserId}/deactivate`, { method: 'POST', headers: { Cookie: adminCookie }, redirect: 'manual' });
    const afterDeactivate = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${token}`, Origin: 'chrome-extension://t' } });
    // setUserActive(false) deletes the session row outright rather than
    // leaving it and relying on the status re-check, so this correctly
    // surfaces as 401 "session missing" -- either way, access is denied
    // immediately, on this very next request, not merely at next login.
    check('an already-issued session stops working the moment the account is deactivated', afterDeactivate.status === 401 || afterDeactivate.status === 403);

    // ---------------------------------------------------------------
    // TEST 8: disabled user cannot log back in either, with the specific
    // required message text.
    // ---------------------------------------------------------------
    const disabledLoginRes = await fetch(`${base}/auth/login`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: 'newlibrarian@example.com', password: 'password123' }) });
    const disabledLoginBody = await disabledLoginRes.json();
    check('disabled account login denied with 403', disabledLoginRes.status === 403);
    check('disabled account login message matches the required wording', /currently inactive/i.test(disabledLoginBody.error) && /contact the AutoCat team/i.test(disabledLoginBody.error));

    // Reactivate and confirm a REJECT transition also denies access with
    // the same message (Reject and Disable are deliberately the same
    // user-facing outcome).
    await fetch(`${base}/admin/users/${pendingUserId}/activate`, { method: 'POST', headers: { Cookie: adminCookie }, redirect: 'manual' });
    const reactivatedLogin = await fetch(`${base}/auth/login`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: 'newlibrarian@example.com', password: 'password123' }) });
    check('reactivated account can log in again', reactivatedLogin.status === 200);

    // ---------------------------------------------------------------
    // TEST: an admin-created account (not the public signup form) is
    // usable immediately -- the PENDING gate is specific to public
    // self-signup, not every account-creation path.
    // ---------------------------------------------------------------
    await fetch(`${base}/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: adminCookie },
      body: 'email=adminmade@example.com&password=password123&institution_slug=demo&subscription_tier=free&device_limit=2',
      redirect: 'manual',
    });
    const adminMadeLogin = await fetch(`${base}/auth/login`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: 'adminmade@example.com', password: 'password123' }) });
    check('an account created directly by an admin is active immediately (no self-signup pending gate)', adminMadeLogin.status === 200);

    // ---------------------------------------------------------------
    // TEST 10: an account that existed before the status column was
    // added (simulated here by inserting directly, bypassing createUser's
    // default) keeps working -- the migration's DEFAULT 'ACTIVE' must
    // never lock out a pre-existing account.
    // ---------------------------------------------------------------
    const directPool = new pg.Pool({ connectionString: databaseUrl, ssl: false });
    const bcrypt = (await import('bcrypt')).default;
    const legacyHash = await bcrypt.hash('password123', 12);
    await directPool.query(
      `INSERT INTO institutions (slug, name) VALUES ('legacy', 'Legacy') ON CONFLICT (slug) DO NOTHING`
    );
    const inst = await directPool.query(`SELECT id FROM institutions WHERE slug = 'legacy'`);
    await directPool.query(
      `INSERT INTO users (email, password_hash, institution_id, subscription_tier) VALUES ($1, $2, $3, 'free')`,
      ['legacyuser@example.com', legacyHash, inst.rows[0].id]
    );
    const legacyStatus = await directPool.query(`SELECT status, is_active FROM users WHERE email = 'legacyuser@example.com'`);
    check('a pre-migration-style row (status not explicitly set) defaults to ACTIVE', legacyStatus.rows[0].status === 'ACTIVE' && legacyStatus.rows[0].is_active === true);
    const legacyLogin = await fetch(`${base}/auth/login`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: 'legacyuser@example.com', password: 'password123' }) });
    check('a pre-existing active account keeps working after the migration', legacyLogin.status === 200);
    await directPool.end();

    // ---------------------------------------------------------------
    // Reject transition (distinct from Disable): a still-PENDING signup
    // explicitly rejected must also be denied, same message.
    // ---------------------------------------------------------------
    const rejectSignup = await fetch(`${base}/auth/signup`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: 'rejectme@example.com', password: 'password123', institution_slug: 'demo' }) });
    const rejectSignupBody = await rejectSignup.json();
    check('second pending signup also returns PENDING, not auto-active', rejectSignupBody.status === 'PENDING');
    const rejectUsersPage = await (await fetch(`${base}/admin/users`, { headers: { Cookie: adminCookie } })).text();
    const rejectUserId = rejectUsersPage.match(/rejectme@example\.com[\s\S]*?#(\d+)/)?.[1];
    await fetch(`${base}/admin/users/${rejectUserId}/reject`, { method: 'POST', headers: { Cookie: adminCookie }, redirect: 'manual' });
    const rejectedLogin = await fetch(`${base}/auth/login`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: 'rejectme@example.com', password: 'password123' }) });
    const rejectedLoginBody = await rejectedLogin.json();
    check('rejected account login denied', rejectedLogin.status === 403);
    check('rejected account login message matches the required wording', /currently inactive/i.test(rejectedLoginBody.error));

    console.log('\nAll account-activation workflow tests passed.');
  } finally {
    child.kill('SIGTERM');
  }
});
