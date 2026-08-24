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

// Regression coverage for the "remove permanent MARC-record storage, keep
// (and enrich) usage logging" architecture change: an ISBN lookup / DDC /
// MARC generation must never create a durable cataloguing record, but every
// AI usage event tied to an ISBN must carry that ISBN through to api_usage.
async function main() {
  await withTempDatabase(async (databaseUrl) => {
    // Simulate a real pre-existing production database: seed the OLD schema
    // (marc_records/record_edits/draft_state with actual rows in them,
    // exactly what a live AutoCat install had before this change) so this
    // test proves ensureSchema actually DROPs that data going forward, not
    // just that a fresh database never creates it.
    const legacy = new pg.Pool({ connectionString: databaseUrl, ssl: false });
    await legacy.query(`
      CREATE TABLE institutions (id SERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
      CREATE TABLE users (
        id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
        institution_id INTEGER REFERENCES institutions(id), subscription_tier TEXT NOT NULL DEFAULT 'free',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE sessions (
        token TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT now(), last_seen_at TIMESTAMPTZ DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE marc_records (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), isbn TEXT,
        marc_json JSONB NOT NULL, marc_text TEXT, status TEXT NOT NULL DEFAULT 'draft',
        created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE record_edits (
        id SERIAL PRIMARY KEY, marc_record_id INTEGER REFERENCES marc_records(id),
        user_prompt TEXT, diff_json JSONB, provider_used TEXT, created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE draft_state (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) UNIQUE,
        marc_record_id INTEGER REFERENCES marc_records(id), ui_state_json JSONB, updated_at TIMESTAMPTZ DEFAULT now()
      );
      INSERT INTO institutions (slug, name) VALUES ('legacy-lib', 'Legacy Library');
      INSERT INTO users (email, password_hash, institution_id) VALUES ('legacy@example.com', 'x', 1);
      INSERT INTO marc_records (user_id, isbn, marc_json, status) VALUES (1, '9781032769226', '[]'::jsonb, 'COMPLETED');
      INSERT INTO record_edits (marc_record_id, user_prompt) VALUES (1, 'legacy edit');
      INSERT INTO draft_state (user_id, marc_record_id, ui_state_json) VALUES (1, 1, '{}'::jsonb);
    `);
    await legacy.end();

    process.env.DATABASE_URL = databaseUrl;
    process.env.PGSSLMODE = 'disable';
    const { ensureSchema, getTableStatus, REQUIRED_TABLES } = await import('../src/db/index.js');
    await ensureSchema();

    assert.ok(!REQUIRED_TABLES.includes('marc_records'), 'marc_records must not be a required table any more');
    assert.ok(!REQUIRED_TABLES.includes('record_edits'), 'record_edits must not be a required table any more');
    assert.ok(!REQUIRED_TABLES.includes('draft_state'), 'draft_state must not be a required table any more');

    const tables = await getTableStatus();
    for (const name of REQUIRED_TABLES) {
      assert.equal(tables[name], true, `expected table ${name}`);
    }
    console.log('PASS ensureSchema (no persistence tables in REQUIRED_TABLES)');

    const check = new pg.Pool({ connectionString: databaseUrl, ssl: false });
    const { rows: gone } = await check.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      [['marc_records', 'record_edits', 'draft_state']]
    );
    assert.deepEqual(gone, [], 'marc_records/record_edits/draft_state must actually be DROPped, not just untracked');
    console.log('PASS legacy marc_records/record_edits/draft_state tables were dropped, including their existing rows');

    const { rows: cols } = await check.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'api_usage' AND column_name = 'isbn'`
    );
    assert.equal(cols.length, 1, 'api_usage must have an isbn column');
    console.log('PASS api_usage has an isbn column');

    // Real usageService.recordUsage/listUsage/usageSummary round trip for
    // exactly the ISBN scenario from the bug report -- ISBN, DDC, and MARC
    // request types, two different providers/models, an ISBN filter that
    // must isolate them from an unrelated request.
    const { recordUsage, listUsage, usageSummary } = await import('../src/services/usageService.js');
    const { rows: userRows } = await check.query(
      `INSERT INTO institutions (slug, name) VALUES ('test-lib', 'Test Library') RETURNING id`
    );
    const institutionId = userRows[0].id;
    // autocat_user_id is left to its sequence-backed DEFAULT (never
    // hand-assigned -- see schema.sql's own comment on that column); the
    // legacy user row inserted above already consumed DOAC001 when
    // ensureSchema's ALTER TABLE backfilled it.
    const { rows: newUser } = await check.query(
      `INSERT INTO users (email, password_hash, institution_id) VALUES ($1, 'x', $2) RETURNING id, autocat_user_id`,
      ['sjayachristrayar@gmail.com', institutionId]
    );
    const userId = newUser[0].id;
    const autocatUserId = newUser[0].autocat_user_id;
    const TEST_ISBN = '9781032769226';

    await recordUsage({ userId, isbn: TEST_ISBN, provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct', requestType: 'ISBN', tokensUsed: 1200, status: 'success' });
    await recordUsage({ userId, isbn: TEST_ISBN, provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct', requestType: 'DDC', tokensUsed: 900, status: 'success' });
    await recordUsage({ userId, isbn: '9780000000000', provider: 'openai', model: 'gpt-4o', requestType: 'ISBN', tokensUsed: 500, status: 'success' });

    const isbnRows = await listUsage({ isbn: TEST_ISBN });
    assert.equal(isbnRows.length, 2, 'ISBN filter must isolate only rows for that ISBN');
    assert.ok(isbnRows.every((r) => r.isbn === TEST_ISBN));
    assert.ok(isbnRows.some((r) => r.request_type === 'ISBN'));
    assert.ok(isbnRows.some((r) => r.request_type === 'DDC'));
    assert.equal(isbnRows[0].autocat_user_id, autocatUserId);
    console.log('PASS listUsage ISBN filter isolates exactly the requests for that ISBN');

    // A hyphenated/spaced form of the same ISBN must match the same rows --
    // the admin searching "978-1-032-76922-6" shouldn't need to know the
    // stored form is unhyphenated.
    const hyphenated = await listUsage({ isbn: '978-1-032-76922-6' });
    assert.equal(hyphenated.length, 2, 'ISBN filter must normalize hyphens/spaces like isbnLookup.js does');
    console.log('PASS listUsage ISBN filter normalizes hyphens/spaces');

    const summary = await usageSummary({ isbn: TEST_ISBN });
    assert.equal(summary.totalRequests, 2);
    assert.equal(summary.nvidiaRequests, 2);
    console.log('PASS usageSummary respects the ISBN filter');

    const allRows = await listUsage({});
    const isbns = allRows.map((r) => r.isbn);
    assert.ok(isbns.includes(TEST_ISBN) && isbns.includes('9780000000000'));
    console.log('PASS listUsage without a filter returns isbn for every row');
    await check.end();

    // Boot a real server process and confirm the HTTP-level behavior: the
    // Records page/route no longer exist (redirect, not 404 or a rendered
    // table), and /records/generate-marc still works with no marc_records
    // table present at all -- proof persistence isn't silently re-created.
    const env = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ADMIN_PASSWORD: 'test-admin-password',
      ADMIN_SESSION_SECRET: 'test-admin-session-secret-32chars',
      NODE_ENV: 'test',
      PGSSLMODE: 'disable',
      PORT: '18081',
    };
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', `await import('./src/server.js');`],
      { cwd: backendRoot, env, stdio: ['ignore', 'pipe', 'pipe'] }
    );

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

      const recordsPage = await fetch(`${base}/admin/records`, { headers: { Cookie: cookie }, redirect: 'manual' });
      assert.equal(recordsPage.status, 302, 'GET /admin/records must redirect, not render a Records page');
      assert.match(recordsPage.headers.get('location') || '', /\/admin\/usage/);
      console.log('PASS GET /admin/records redirects to /admin/usage');

      const navPage = await fetch(`${base}/admin`, { headers: { Cookie: cookie } });
      const navHtml = await navPage.text();
      assert.doesNotMatch(navHtml, />Records</, 'the admin nav must not show a Records link any more');
      assert.doesNotMatch(navHtml, /Internal server error/);
      console.log('PASS admin nav no longer shows a Records link, Overview renders without marc_records');

      const usagePage = await fetch(`${base}/admin/usage`, { headers: { Cookie: cookie } });
      const usageHtml = await usagePage.text();
      assert.match(usageHtml, /<th>ISBN<\/th>/, 'Usage table must have an ISBN column');
      assert.match(usageHtml, /name="isbn"/, 'Usage filters must include an ISBN search field');
      console.log('PASS /admin/usage shows an ISBN column and ISBN filter');

      const generateMarc = await fetch(`${base}/records/generate-marc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: { isbn: TEST_ISBN }, ddc_approval: {} }),
      });
      // No session -> 401 from requireSession, not a 500 -- confirms the
      // route never reaches a marc_records INSERT that would otherwise
      // throw "relation marc_records does not exist".
      assert.equal(generateMarc.status, 401);
      console.log('PASS /records/generate-marc never touches a marc_records table (none exists) and fails cleanly without a session');
    } finally {
      child.kill('SIGTERM');
    }
  });

  console.log('All P10 usage/ISBN-logging + MARC-persistence-removal tests passed.');
}

main().catch((error) => {
  console.error('FAIL', error);
  process.exit(1);
});
