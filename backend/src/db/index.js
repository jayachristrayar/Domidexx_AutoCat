import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REQUIRED_TABLES = [
  'institutions',
  'users',
  'sessions',
  'isbn_cache',
  'marc_records',
  'record_edits',
  'api_usage',
  'draft_state',
  'ddc_relative_index',
  'ddc_classes',
  'ddc_aliases',
  'ddc_decisions',
  'marc_frameworks',
  'marc_fields',
  'marc_subfields',
  'marc_indicators',
  'framework_field_settings',
  'framework_subfield_settings',
];

function buildPoolConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. The AutoCat backend cannot start without a Postgres connection string.'
    );
  }

  // Hosted Postgres (Neon, Render, etc.) requires TLS. `sslmode=require` in the
  // URL is enough for many drivers, but node-pg 8.x has been tightening that
  // into certificate verification that fails against some managed providers'
  // intermediate CAs. Prefer encrypting the link without failing the handshake
  // on CA quirks; local/dev URLs stay plaintext.
  const isLocal =
    /@(localhost|127\.0\.0\.1)[:/]/i.test(connectionString) ||
    process.env.PGSSLMODE === 'disable';

  return {
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  };
}

const pool = new Pool(buildPoolConfig());

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error:', err.message);
});

let schemaReady = null;

// Strip line comments first, then split on ';' so a semicolon inside a
// comment (common in schema headers) cannot create a bogus statement.
function splitSqlStatements(sql) {
  const withoutLineComments = sql
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('--')) return '';
      const commentIndex = line.indexOf('--');
      return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
    })
    .join('\n');

  return withoutLineComments
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function ensureSchema() {
  if (schemaReady) return schemaReady;

  schemaReady = (async () => {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    const statements = splitSqlStatements(sql);
    const errors = [];

    for (const statement of statements) {
      try {
        await pool.query(statement);
      } catch (error) {
        errors.push({ statement: statement.slice(0, 80), message: error.message });
        console.error('Schema statement failed:', error.message);
      }
    }

    const tables = await getTableStatus();
    const missing = REQUIRED_TABLES.filter((name) => !tables[name]);
    if (missing.length > 0) {
      const detail = `Missing tables after ensureSchema: ${missing.join(', ')}`;
      console.error(detail);
      if (errors.length) {
        console.error('Schema statement errors:', errors.map((e) => e.message).join(' | '));
      }
      throw new Error(detail);
    }

    console.log('Database schema ensured.');
  })().catch((err) => {
    // Allow a later retry after a transient outage rather than permanently
    // latching the failed promise.
    schemaReady = null;
    throw err;
  });

  return schemaReady;
}

export async function checkDatabase() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

export async function getTableStatus() {
  const { rows } = await pool.query(
    `SELECT tablename
     FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename = ANY($1::text[])`,
    [REQUIRED_TABLES]
  );
  const present = new Set(rows.map((row) => row.tablename));
  return Object.fromEntries(REQUIRED_TABLES.map((name) => [name, present.has(name)]));
}

export function getConfigStatus() {
  // Report SET / NOT SET only -- never values.
  const keys = [
    'DATABASE_URL',
    'ADMIN_PASSWORD',
    'ADMIN_SESSION_SECRET',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'NVIDIA_API_KEY',
    'NVIDIA_BASE_URL',
    'NVIDIA_MODEL',
    'GOOGLE_BOOKS_API_KEY',
    'LIBRARYTHING_API_KEY',
    'NODE_ENV',
  ];
  return Object.fromEntries(keys.map((key) => [key, process.env[key] ? 'SET' : 'NOT SET']));
}

export default pool;
