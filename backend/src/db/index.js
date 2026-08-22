import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  console.error('Unexpected Postgres pool error:', err);
});

let schemaReady = null;

export async function ensureSchema() {
  if (schemaReady) return schemaReady;

  schemaReady = (async () => {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(sql);
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

export default pool;
