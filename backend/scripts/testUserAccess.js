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
  const dbName = `autocat_access_${Date.now()}`;
  const admin = new pg.Pool({
    connectionString: 'postgresql://autocat:autocat@127.0.0.1:5432/postgres',
    ssl: false,
  });
  await admin.query(`CREATE DATABASE ${dbName}`);
  const databaseUrl = `postgresql://autocat:autocat@127.0.0.1:5432/${dbName}`;
  try {
    await run(databaseUrl);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
}

await withTempDatabase(async (databaseUrl) => {
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    ADMIN_PASSWORD: 'test-admin-password',
    ADMIN_SESSION_SECRET: 'test-admin-session-secret-32chars',
    NODE_ENV: 'test',
    PGSSLMODE: 'disable',
    PORT: '18081',
  };

  const child = spawn(process.execPath, ['./src/server.js'], {
    cwd: backendRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForOutput(child, /AutoCat backend listening/);
    const base = 'http://127.0.0.1:18081';

    const login = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=test-admin-password',
      redirect: 'manual',
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];

    await fetch(`${base}/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: 'email=limited@example.com&password=password123&institution_slug=demo&subscription_tier=free&device_limit=1',
      redirect: 'manual',
    });

    const usersPage = await (await fetch(`${base}/admin/users`, { headers: { Cookie: cookie } })).text();
    assert.match(usersPage, /Activate|Deactivate|Device limit|Delete account|primary-blue|#2DA9DF|logo-64/);
    const userId = usersPage.match(/limited@example\.com[\s\S]*?#(\d+)/)?.[1];
    assert.ok(userId);

    const a = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://t', 'X-Device-Id': 'device-a' },
      body: JSON.stringify({ email: 'limited@example.com', password: 'password123', device_id: 'device-a' }),
    });
    assert.equal(a.status, 200);
    const tokenA = (await a.json()).token;

    const b = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://t', 'X-Device-Id': 'device-b' },
      body: JSON.stringify({ email: 'limited@example.com', password: 'password123', device_id: 'device-b' }),
    });
    assert.equal(b.status, 200);
    const tokenB = (await b.json()).token;

    const meA = await fetch(`${base}/me`, {
      headers: { Authorization: `Bearer ${tokenA}`, Origin: 'chrome-extension://t' },
    });
    assert.equal(meA.status, 401, 'old device session should be evicted');

    const meB = await fetch(`${base}/me`, {
      headers: { Authorization: `Bearer ${tokenB}`, Origin: 'chrome-extension://t' },
    });
    assert.equal(meB.status, 200);

    await fetch(`${base}/admin/users/${userId}/deactivate`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    const blocked = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://t' },
      body: JSON.stringify({ email: 'limited@example.com', password: 'password123' }),
    });
    assert.equal(blocked.status, 403);

    await fetch(`${base}/admin/users/${userId}/activate`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    const past = encodeURIComponent(new Date(Date.now() - 86400000).toISOString().slice(0, 16));
    await fetch(`${base}/admin/users/${userId}/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: `device_limit=2&expires_at=${past}`,
      redirect: 'manual',
    });
    const expired = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://t' },
      body: JSON.stringify({ email: 'limited@example.com', password: 'password123' }),
    });
    assert.equal(expired.status, 403);

    await fetch(`${base}/admin/users/${userId}/delete`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    const gone = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://t' },
      body: JSON.stringify({ email: 'limited@example.com', password: 'password123' }),
    });
    assert.equal(gone.status, 401);

    const css = await (await fetch(`${base}/admin.css`)).text();
    assert.match(css, /#2DA9DF/);
    assert.match(css, /#F2B321/);
    assert.doesNotMatch(css, /background:\s*#fff;\s*\n\s*object-fit/);

    console.log('PASS user access controls + Domidexx brand tokens');
  } finally {
    child.kill('SIGTERM');
  }
});
