import assert from 'assert';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..');

function waitForOutput(child, pattern, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${pattern}. Output:\n${buffer}`));
    }, timeoutMs);

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
      reject(new Error(`Process exited early (${code}). Output:\n${buffer}`));
    });
  });
}

async function withTempDatabase(run) {
  const dbName = `autocat_test_${Date.now()}`;
  const adminUrl = process.env.TEST_DATABASE_URL || 'postgresql://autocat:autocat@127.0.0.1:5432/postgres';
  const admin = new pg.Pool({ connectionString: adminUrl, ssl: false });
  await admin.query(`CREATE DATABASE ${dbName}`);
  const databaseUrl = `postgresql://autocat:autocat@127.0.0.1:5432/${dbName}`;
  try {
    await run(databaseUrl);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
}

async function main() {
  await withTempDatabase(async (databaseUrl) => {
    // Partial schema that mirrors the suspected production failure mode:
    // auth tables exist, marc_records does not, until ensureSchema repairs it.
    const partial = new pg.Pool({ connectionString: databaseUrl, ssl: false });
    await partial.query(`
      CREATE TABLE institutions (
        id SERIAL PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL
      );
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        institution_id INTEGER REFERENCES institutions(id),
        subscription_tier TEXT NOT NULL DEFAULT 'free',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT now(),
        last_seen_at TIMESTAMPTZ DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      );
    `);
    await partial.end();

    const env = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ADMIN_PASSWORD: 'test-admin-password',
      ADMIN_SESSION_SECRET: 'test-admin-session-secret-32chars',
      NODE_ENV: 'test',
      PORT: '0',
      PGSSLMODE: 'disable',
    };

    // Import ensureSchema against this DB directly (unit-style).
    process.env.DATABASE_URL = databaseUrl;
    process.env.PGSSLMODE = 'disable';
    const { ensureSchema, getTableStatus, REQUIRED_TABLES } = await import('../src/db/index.js');
    await ensureSchema();
    const tables = await getTableStatus();
    for (const name of REQUIRED_TABLES) {
      assert.equal(tables[name], true, `expected table ${name}`);
    }
    console.log('PASS ensureSchema repairs partial schema');

    // Boot a real server process for the HTTP admin flow.
    const portFile = path.join(os.tmpdir(), `autocat-port-${process.pid}.txt`);
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        process.env.PORT = process.env.PORT || '18080';
        await import('./src/server.js');
        `,
      ],
      {
        cwd: backendRoot,
        env: { ...env, PORT: '18080' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    try {
      await waitForOutput(child, /AutoCat backend listening/);
      const base = 'http://127.0.0.1:18080';

      const health = await fetch(`${base}/health`).then((r) => r.json());
      assert.equal(health.status, 'ok');
      assert.equal(health.database, 'up');
      assert.deepEqual(health.missing_tables, []);
      assert.equal(health.config.DATABASE_URL, 'SET');
      assert.equal(health.config.ADMIN_PASSWORD, 'SET');
      assert.equal(health.config.ADMIN_SESSION_SECRET, 'SET');
      console.log('PASS /health reports tables + config SET/NOT SET');

      const wrong = await fetch(`${base}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'password=wrong',
        redirect: 'manual',
      });
      assert.equal(wrong.status, 302);
      assert.match(wrong.headers.get('location') || '', /error=1/);
      console.log('PASS admin login rejects bad password');

      const login = await fetch(`${base}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'password=test-admin-password',
        redirect: 'manual',
      });
      assert.equal(login.status, 302);
      assert.equal(login.headers.get('location'), '/admin');
      const cookie = login.headers.get('set-cookie');
      assert.ok(cookie && cookie.includes('autocat_admin_session='));
      console.log('PASS admin login sets session cookie');

      const dash = await fetch(`${base}/admin`, {
        headers: { Cookie: cookie.split(';')[0] },
      });
      const html = await dash.text();
      assert.equal(dash.status, 200, html.slice(0, 200));
      assert.match(html, /Dashboard/);
      assert.match(html, /MARC records/);
      assert.doesNotMatch(html, /Internal server error/);
      console.log('PASS authenticated GET /admin renders dashboard');

      const users = await fetch(`${base}/admin/users`, {
        headers: { Cookie: cookie.split(';')[0] },
      });
      assert.equal(users.status, 200);
      console.log('PASS GET /admin/users');
    } finally {
      child.kill('SIGTERM');
      try {
        fs.unlinkSync(portFile);
      } catch {
        // ignore
      }
    }
  });

  console.log('All P0 admin/schema tests passed.');
}

main().catch((error) => {
  console.error('FAIL', error);
  process.exit(1);
});
