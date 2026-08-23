// Must be the first import: ES module imports are evaluated in order, each
// one's body fully run before the next import starts. './routes/admin.js'
// below transitively imports './db/index.js', which reads
// process.env.DATABASE_URL to construct the pg Pool at module-eval time --
// that happens before any code in *this* file runs, so a `dotenv.config()`
// call placed after the imports (as this used to be) is too late to
// populate process.env from a local .env file. `dotenv/config` runs
// dotenv's config() as a side effect of being imported, so loading it first
// guarantees env vars are set before anything downstream reads them.
import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ensureSchema,
  checkDatabase,
  getTableStatus,
  getConfigStatus,
  REQUIRED_TABLES,
} from './db/index.js';
import adminRouter from './routes/admin.js';
import authRouter from './routes/auth.js';
import meRouter from './routes/me.js';
import recordsRouter from './routes/records.js';
import ddcRouter from './routes/ddc.js';
import marcFrameworksRouter from './routes/marcFrameworks.js';
import chatRouter from './routes/chat.js';
import { startModelRefreshSchedule } from './services/openaiModelSelector.js';
import { seedMarcFrameworks } from './services/marcFrameworkService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// The extension calls this API directly from its popup/content scripts
// (Manifest V3, so requests carry a chrome-extension:// origin, not a
// normal http(s):// one). Requests with no Origin header (server-to-server
// calls, curl, health checks) aren't subject to CORS at all and are let
// through; anything else is rejected rather than reflected back like a
// blanket `origin: true` would. Scoped to just the extension-facing API
// routes -- /admin is a server-rendered dashboard navigated directly by a
// human's ordinary browser, whose same-origin form POSTs would otherwise
// get rejected by this same check (a same-origin form submission still
// carries an Origin header, just not a chrome-extension:// one).
class CorsOriginError extends Error {}

const extensionCors = cors({
  origin: (origin, callback) => {
    if (!origin || origin.startsWith('chrome-extension://')) {
      callback(null, true);
    } else {
      callback(new CorsOriginError('Not allowed by CORS'));
    }
  },
  credentials: true,
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir));

function classifyError(err) {
  if (!err) return 'internal_error';
  if (err.code === '42P01') return 'database_error'; // undefined_table
  if (err.code === '28P01' || err.code === '28000') return 'database_error';
  if (typeof err.code === 'string' && err.code.startsWith('08')) return 'database_error';
  if (err.code === 'ADMIN_PASSWORD_MISSING' || err.code === 'ADMIN_SESSION_SECRET_MISSING') {
    return 'configuration_error';
  }
  if (err.type === 'entity.parse.failed') return 'validation_error';
  return 'internal_error';
}

function isAdminRequest(req) {
  const target = req.originalUrl || req.url || req.path || '';
  return target.startsWith('/admin');
}

app.get('/health', async (_req, res) => {
  const config = getConfigStatus();
  try {
    await checkDatabase();
    const tables = await getTableStatus();
    const missingTables = REQUIRED_TABLES.filter((name) => !tables[name]);
    const healthy = missingTables.length === 0 && config.DATABASE_URL === 'SET';

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      database: 'up',
      tables,
      missing_tables: missingTables,
      config,
    });
  } catch (error) {
    console.error('Health check database failure:', {
      code: error.code || null,
      message: error.message,
    });
    res.status(503).json({
      status: 'degraded',
      database: 'down',
      error_class: classifyError(error),
      config,
    });
  }
});

app.use('/admin', adminRouter);
app.use('/auth', extensionCors, authRouter);
app.use('/me', extensionCors, meRouter);
app.use('/records', extensionCors, recordsRouter);
app.use('/api/ddc', extensionCors, ddcRouter);
app.use('/api/marc-frameworks', extensionCors, marcFrameworksRouter);
app.use('/api/chat', extensionCors, chatRouter);

app.use((err, req, res, _next) => {
  if (err instanceof CorsOriginError) {
    res.status(403).json({ error: 'Origin not allowed', error_class: 'authorization_error' });
    return;
  }

  const errorClass = classifyError(err);
  console.error('Request failed:', {
    error_class: errorClass,
    code: err.code || null,
    message: err.message,
    path: req.originalUrl || req.path,
  });

  if (isAdminRequest(req)) {
    const missingRelation =
      err.code === '42P01'
        ? `<p class="err">Database table missing: <code>${escapeHtmlSafe(err.table || err.message)}</code>. Schema ensure may have failed on boot — check <code>/health</code>.</p>`
        : '';

    res.status(500).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><title>Error — AutoCat Admin</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:64px auto;padding:0 16px;color:#1a1a1a}
.err{background:#fde8e8;border:1px solid #f3b8b8;color:#a11;padding:12px 14px;border-radius:6px}
code{font-size:13px}</style>
</head><body>
<h1>Admin dashboard error</h1>
<div class="err">Something went wrong while loading this page (<code>${escapeHtmlSafe(errorClass)}</code>).</div>
${missingRelation}
<p>Safe checks: open <a href="/health"><code>/health</code></a> and confirm <code>database</code> is up and <code>missing_tables</code> is empty. Confirm <code>ADMIN_PASSWORD</code>, <code>ADMIN_SESSION_SECRET</code>, and <code>DATABASE_URL</code> are SET in Render.</p>
<p><a href="/admin/login">Back to login</a></p>
</body></html>`);
    return;
  }

  res.status(500).json({ error: 'Internal server error', error_class: errorClass });
});

function escapeHtmlSafe(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Database schema/seed init used to be awaited BEFORE app.listen() -- on at
// least one deploy that left the process stuck between "Database schema
// ensured." and ever calling listen() (whatever the exact cause -- a slow
// or stuck seedMarcFrameworks() upsert, a transient pool issue, etc.),
// which reads to Render as "no open port" and fails the deploy outright,
// even though the app would likely have recovered on its own. None of this
// work should ever be able to delay the HTTP server coming up: Render
// (and any platform doing a port-open health check) needs to see a
// listening socket promptly, and /health already independently reports
// live DB status on every request regardless of what happened at boot --
// it was never relying on this function having already run.
async function initializeDatabase() {
  try {
    await ensureSchema();
  } catch (error) {
    console.error('Failed to ensure database schema on startup:', {
      code: error.code || null,
      message: error.message,
    });
    // Request handlers that touch the DB will keep returning errors until
    // connectivity/schema is fixed; /health surfaces this independently.
    return;
  }

  try {
    // seedMarcFrameworks() is an idempotent set of ON CONFLICT upserts (see
    // marcFrameworkService.js) -- safe to run on every boot, the same way
    // ensureSchema() is. Without this, a fresh deploy's marc_frameworks
    // table stays empty forever unless someone manually runs
    // `npm run seed:marc-frameworks`, which is not something the production
    // Admin UI should ever have to tell an admin to do.
    const seeded = await seedMarcFrameworks();
    console.log(`MARC frameworks ensured: ${seeded.generalFields} General MARC21 fields, ${seeded.customFields} custom framework fields.`);
  } catch (error) {
    console.error('Failed to seed MARC frameworks on startup:', {
      code: error.code || null,
      message: error.message,
    });
  }

  console.log('Database initialization completed.');
}

function start() {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`AutoCat backend listening on 0.0.0.0:${PORT}`);
    // Fire-and-forget: intentionally not awaited so nothing DB/seed-related
    // can ever delay or block the already-open port.
    initializeDatabase();
    startModelRefreshSchedule();
  });

  server.on('error', (error) => {
    console.error('Failed to bind HTTP server:', { code: error.code || null, message: error.message });
    process.exit(1);
  });
}

start();
