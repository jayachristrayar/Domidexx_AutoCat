import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import { z } from 'zod';
import pool from '../db/index.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  requireAdminSession,
  createAdminSessionCookie,
  clearAdminSessionCookie,
  assertAdminSecretsConfigured,
} from '../middleware/requireAdminSession.js';
import {
  createUser,
  resetUserPassword,
  UserAlreadyExistsError,
  UserNotFoundError,
} from '../services/userService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_DIR = path.join(__dirname, '..', '..', 'rules');

const router = Router();

const RECORDS_PAGE_SIZE = 50;


function adminConfigErrorMessage() {
  if (!process.env.ADMIN_PASSWORD) {
    return 'ADMIN_PASSWORD is not set on the server. Add it in the Render environment variables, then redeploy.';
  }
  if (!process.env.ADMIN_SESSION_SECRET) {
    return 'ADMIN_SESSION_SECRET is not set on the server. Add a long random value in the Render environment variables, then redeploy.';
  }
  return null;
}

function renderLoginPage({ errorHtml = '' } = {}) {
  const configError = adminConfigErrorMessage();
  const configBanner = configError
    ? `<div class="error">${escapeHtml(configError)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Admin Login — Domidexx AutoCat</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,560;9..144,650&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/admin.css" />
<link rel="icon" href="/logo/logo-32.png" />
</head>
<body>
<div class="login-shell">
  <form class="login-card" method="POST" action="/admin/login">
    <div class="login-brand">
      <img src="/logo/logo-64.png" width="48" height="48" alt="Domidexx AutoCat logo" />
      <div>
        <h1>Domidexx AutoCat</h1>
        <p>Admin console</p>
      </div>
    </div>
    ${configBanner}
    ${errorHtml}
    <label><span>Admin password</span>
      <input type="password" name="password" required autofocus ${configError ? 'disabled' : ''} />
    </label>
    <button class="btn" type="submit" ${configError ? 'disabled' : ''}>Log in</button>
    <p class="muted" style="margin-top:14px;font-size:0.82rem">Library user passwords are managed on the Users page after login. The shared admin password is set via the <code>ADMIN_PASSWORD</code> environment variable in Render.</p>
  </form>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------
// Tiny HTML helpers -- plain server-rendered pages, no build step. This is
// an internal tool: function over polish.
// ---------------------------------------------------------------------

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const NAV_ITEMS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/records', label: 'Records' },
  { href: '/admin/usage', label: 'Usage' },
  { href: '/admin/rules', label: 'Rules' },
  { href: '/admin/settings', label: 'Settings' },
];

function layout({ title, activeHref, body }) {
  const nav = NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}" class="${item.href === activeHref ? 'active' : ''}">${item.label}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — Domidexx AutoCat Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,560;9..144,650&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/admin.css" />
<link rel="icon" href="/logo/logo-32.png" />
</head>
<body>
<header class="topbar">
  <a class="brand" href="/admin">
    <img src="/logo/logo-64.png" width="36" height="36" alt="Domidexx AutoCat logo" />
    <span class="brand-text">
      <strong>Domidexx AutoCat</strong>
      <span>Admin console</span>
    </span>
  </a>
  <nav>${nav}</nav>
  <div class="topbar-actions">
    <form method="POST" action="/admin/logout"><button type="submit">Log out</button></form>
  </div>
</header>
<main>
${body}
</main>
</body>
</html>`;
}

// ---------------------------------------------------------------------
// Login / logout
// ---------------------------------------------------------------------

function verifyAdminPassword(password) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  // Fixed-length digests before comparing, so timingSafeEqual never leaks
  // the real password's length via a buffer-length mismatch.
  const submittedDigest = crypto.createHash('sha256').update(password).digest();
  const expectedDigest = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(submittedDigest, expectedDigest);
}

router.get('/login', (req, res) => {
  const errorHtml = req.query.error ? '<div class="error">Incorrect password.</div>' : '';
  res.send(renderLoginPage({ errorHtml }));
});

const loginSchema = z.object({ password: z.string().min(1) });

router.post('/login', (req, res) => {
  const configError = adminConfigErrorMessage();
  if (configError) {
    return res.status(503).send(renderLoginPage());
  }

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success || !verifyAdminPassword(parsed.data.password)) {
    return res.redirect('/admin/login?error=1');
  }

  try {
    assertAdminSecretsConfigured();
    res.setHeader('Set-Cookie', createAdminSessionCookie());
  } catch (error) {
    console.error('Admin login cookie failed:', error.message);
    return res.status(503).send(
      renderLoginPage({
        errorHtml: `<div class="error">${escapeHtml(error.message)}</div>`,
      })
    );
  }

  res.redirect('/admin');
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearAdminSessionCookie());
  res.redirect('/admin/login');
});

// Everything from here down requires a valid admin session.
router.use(requireAdminSession);

// ---------------------------------------------------------------------
// Dashboard home
// ---------------------------------------------------------------------

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    let userCount;
    let recordCount;
    try {
      [{ rows: userCount }, { rows: recordCount }] = await Promise.all([
        pool.query('SELECT count(*) FROM users'),
        pool.query('SELECT count(*) FROM marc_records'),
      ]);
    } catch (error) {
      // Surface undefined_table etc. through the HTML error page with a class.
      error.message = `Dashboard query failed: ${error.message}`;
      throw error;
    }

    res.send(
      layout({
        title: 'Overview',
        activeHref: '/admin',
        body: `
          <h2>Overview</h2>
          <p class="lede">Monitor cataloguers, drafted MARC records, and system health. Library user passwords can be reset on the Users page.</p>
          <div class="grid-2">
            <div class="panel">
              <h3 class="panel-title">Library users</h3>
              <p style="font-size:2rem;margin:0;font-family:var(--font-display)">${userCount[0].count}</p>
              <p class="muted">Accounts that sign in through the AutoCat extension.</p>
            </div>
            <div class="panel">
              <h3 class="panel-title">MARC records</h3>
              <p style="font-size:2rem;margin:0;font-family:var(--font-display)">${recordCount[0].count}</p>
              <p class="muted">Draft and completed records stored in Postgres.</p>
            </div>
          </div>
          <div class="panel">
            <h3 class="panel-title">Quick links</h3>
            <p class="muted"><a href="/admin/users">Manage users &amp; passwords</a> · <a href="/admin/records">Review records</a> · <a href="/health">System health JSON</a></p>
          </div>
        `,
      })
    );
  })
);

// ---------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  institution_slug: z.string().min(1),
  subscription_tier: z.enum(['free', 'paid']),
});

function renderUsersPage({ users, formError, notice }) {
  const rows = users
    .map((user) => {
      const lastSeen = user.last_seen_at
        ? new Date(user.last_seen_at).toLocaleString()
        : '<span class="muted">never</span>';
      return `<tr>
        <td>
          <strong>${escapeHtml(user.email)}</strong>
          <div class="muted" style="font-size:0.8rem">#${user.id}</div>
        </td>
        <td>${escapeHtml(user.institution_name ?? '—')}</td>
        <td><span class="badge">${escapeHtml(user.subscription_tier)}</span></td>
        <td>${new Date(user.created_at).toLocaleDateString()}</td>
        <td>${lastSeen}</td>
        <td>
          <form class="inline" method="POST" action="/admin/users/${user.id}/tier">
            <select name="tier">
              <option value="free" ${user.subscription_tier === 'free' ? 'selected' : ''}>free</option>
              <option value="paid" ${user.subscription_tier === 'paid' ? 'selected' : ''}>paid</option>
            </select>
            <button type="submit" class="btn">Save tier</button>
          </form>
        </td>
        <td>
          <form class="inline" method="POST" action="/admin/users/${user.id}/password">
            <input type="password" name="password" minlength="8" placeholder="New password" required autocomplete="new-password" />
            <button type="submit" class="btn btn-secondary">Set password</button>
          </form>
        </td>
      </tr>`;
    })
    .join('');

  return layout({
    title: 'Users',
    activeHref: '/admin/users',
    body: `
      <h2>Users</h2>
      <p class="lede">Create cataloguer accounts and reset passwords manually. Setting a password clears that user's extension sessions.</p>
      ${formError ? `<div class="error">${escapeHtml(formError)}</div>` : ''}
      ${notice ? `<div class="success">${escapeHtml(notice)}</div>` : ''}
      <div class="panel table-wrap">
        <table>
          <thead><tr><th>Email</th><th>Institution</th><th>Tier</th><th>Created</th><th>Last active</th><th>Change tier</th><th>Reset password</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7" class="muted">No users yet.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="panel">
        <h3 class="panel-title">Create user</h3>
        <form class="stack-form" method="POST" action="/admin/users">
          <label><span>Email</span><input type="email" name="email" required /></label>
          <label><span>Password</span><input type="password" name="password" minlength="8" required autocomplete="new-password" /></label>
          <label><span>Institution slug</span><input type="text" name="institution_slug" placeholder="e.g. riverside-public-library" required /></label>
          <label><span>Subscription tier</span>
            <select name="subscription_tier">
              <option value="free">free</option>
              <option value="paid">paid</option>
            </select>
          </label>
          <button class="btn" type="submit">Create user</button>
        </form>
      </div>
    `,
  });
}

router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const { rows: users } = await pool.query(
      `SELECT u.id, u.email, u.subscription_tier, u.created_at, i.name AS institution_name,
              MAX(s.last_seen_at) AS last_seen_at
       FROM users u
       LEFT JOIN institutions i ON i.id = u.institution_id
       LEFT JOIN sessions s ON s.user_id = u.id
       GROUP BY u.id, i.name
       ORDER BY u.created_at DESC`
    );

    res.send(
      renderUsersPage({
        users,
        formError: req.query.error || null,
        notice: req.query.created
          ? 'User created.'
          : req.query.password_reset
            ? 'Password updated. Existing extension sessions for that user were signed out.'
            : null,
      })
    );
  })
);

router.post(
  '/users',
  asyncHandler(async (req, res) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.redirect(`/admin/users?error=${encodeURIComponent('Invalid form input.')}`);
    }

    try {
      await createUser({
        email: parsed.data.email,
        password: parsed.data.password,
        institutionSlug: parsed.data.institution_slug,
        subscriptionTier: parsed.data.subscription_tier,
      });
    } catch (error) {
      if (error instanceof UserAlreadyExistsError) {
        return res.redirect(`/admin/users?error=${encodeURIComponent('Email already registered.')}`);
      }
      throw error;
    }

    res.redirect('/admin/users?created=1');
  })
);

const tierSchema = z.object({ tier: z.enum(['free', 'paid']) });
const passwordSchema = z.object({ password: z.string().min(8) });

router.post(
  '/users/:id/tier',
  asyncHandler(async (req, res) => {
    const parsed = tierSchema.safeParse(req.body);
    const userId = Number(req.params.id);
    if (!parsed.success || !Number.isInteger(userId)) {
      return res.redirect(`/admin/users?error=${encodeURIComponent('Invalid tier update.')}`);
    }

    await pool.query('UPDATE users SET subscription_tier = $1 WHERE id = $2', [parsed.data.tier, userId]);
    res.redirect('/admin/users');
  })
);

router.post(
  '/users/:id/password',
  asyncHandler(async (req, res) => {
    const parsed = passwordSchema.safeParse(req.body);
    const userId = Number(req.params.id);
    if (!parsed.success || !Number.isInteger(userId)) {
      return res.redirect(`/admin/users?error=${encodeURIComponent('Password must be at least 8 characters.')}`);
    }

    try {
      await resetUserPassword(userId, parsed.data.password);
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        return res.redirect(`/admin/users?error=${encodeURIComponent('User not found.')}`);
      }
      throw error;
    }

    res.redirect('/admin/users?password_reset=1');
  })
);

router.get('/settings', (_req, res) => {
  res.send(
    layout({
      title: 'Settings',
      activeHref: '/admin/settings',
      body: `
        <h2>Settings</h2>
        <p class="lede">Password and branding notes for operators.</p>
        <div class="panel">
          <h3 class="panel-title">Library user passwords</h3>
          <p>Reset any cataloguer password from <a href="/admin/users">Users → Reset password</a>. That updates the stored hash and signs out their extension sessions immediately.</p>
        </div>
        <div class="panel">
          <h3 class="panel-title">Admin console password</h3>
          <p>There is a single shared admin password (no per-admin accounts yet). Change it in the Render dashboard:</p>
          <ol>
            <li>Open the Domidexx_AutoCat service → Environment</li>
            <li>Edit <code>ADMIN_PASSWORD</code></li>
            <li>Save and redeploy / restart so the new value is loaded</li>
          </ol>
          <p class="muted">The value is never shown in this UI and is not stored in the database.</p>
        </div>
        <div class="panel">
          <h3 class="panel-title">Brand logo</h3>
          <p>The header uses the Domidexx AutoCat mark from <code>/logo/logo-64.png</code>.</p>
          <img src="/logo/logo-128.png" width="96" height="96" alt="Domidexx AutoCat logo preview" style="border-radius:16px;background:#fff;border:1px solid var(--line)" />
        </div>
        <div class="notice">
          The green “Add MARC record” screens with tabs 0–9 are <strong>Koha’s own cataloguing UI</strong>. AutoCat fills fields into Koha; it does not replace Koha’s chrome. UI refreshes here apply to the AutoCat admin console and extension.
        </div>
      `,
    })
  );
});

// ---------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------

function extractTitleFromMarcJson(marcJson) {
  if (!Array.isArray(marcJson)) return null;
  const field245 = marcJson.find((field) => field.tag === '245');
  const subfieldA = field245?.subfields?.find((subfield) => subfield.code === 'a')?.value;
  return subfieldA ? subfieldA.replace(/[\s/:;,.]+$/, '') : null;
}

router.get(
  '/records',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const offset = (page - 1) * RECORDS_PAGE_SIZE;

    const [{ rows: records }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT r.id, r.isbn, r.marc_json, r.status, r.created_at, u.email AS user_email
         FROM marc_records r
         LEFT JOIN users u ON u.id = r.user_id
         ORDER BY r.created_at DESC
         LIMIT $1 OFFSET $2`,
        [RECORDS_PAGE_SIZE, offset]
      ),
      pool.query('SELECT count(*) FROM marc_records'),
    ]);

    const total = Number(countRows[0].count);
    const totalPages = Math.max(1, Math.ceil(total / RECORDS_PAGE_SIZE));

    const rows = records
      .map((record) => {
        const title = extractTitleFromMarcJson(record.marc_json) ?? '<span class="muted">(no title)</span>';
        return `<tr>
          <td><a href="/admin/records/${record.id}">${escapeHtml(record.isbn ?? '—')}</a></td>
          <td>${title}</td>
          <td>${escapeHtml(record.user_email ?? '—')}</td>
          <td>${escapeHtml(record.status)}</td>
          <td>${new Date(record.created_at).toLocaleString()}</td>
        </tr>`;
      })
      .join('');

    const pagination = `
      <div class="pagination">
        ${page > 1 ? `<a href="/admin/records?page=${page - 1}">&larr; Newer</a>` : '<span class="muted">&larr; Newer</span>'}
        <span>Page ${page} of ${totalPages}</span>
        ${page < totalPages ? `<a href="/admin/records?page=${page + 1}">Older &rarr;</a>` : '<span class="muted">Older &rarr;</span>'}
      </div>`;

    res.send(
      layout({
        title: 'Records',
        activeHref: '/admin/records',
        body: `
          <h2>Records</h2>
          <p class="lede">${total} MARC record${total === 1 ? '' : 's'} total.</p>
          <div class="panel table-wrap">
          <table>
            <thead><tr><th>ISBN</th><th>Title</th><th>User</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="5" class="muted">No records yet.</td></tr>'}</tbody>
          </table>
          </div>
          ${pagination}
        `,
      })
    );
  })
);

router.get(
  '/records/:id',
  asyncHandler(async (req, res) => {
    const recordId = Number(req.params.id);
    if (!Number.isInteger(recordId)) {
      return res.status(400).send('Invalid record id.');
    }

    const { rows: recordRows } = await pool.query(
      `SELECT r.id, r.isbn, r.marc_text, r.status, r.created_at, u.email AS user_email
       FROM marc_records r
       LEFT JOIN users u ON u.id = r.user_id
       WHERE r.id = $1`,
      [recordId]
    );
    const record = recordRows[0];
    if (!record) {
      return res.status(404).send('Record not found.');
    }

    const { rows: edits } = await pool.query(
      'SELECT user_prompt, created_at FROM record_edits WHERE marc_record_id = $1 ORDER BY created_at ASC',
      [recordId]
    );

    const editsHtml = edits
      .map(
        (edit) => `<tr>
          <td>${new Date(edit.created_at).toLocaleString()}</td>
          <td>${escapeHtml(edit.user_prompt ?? '—')}</td>
        </tr>`
      )
      .join('');

    res.send(
      layout({
        title: `Record ${record.isbn ?? record.id}`,
        activeHref: '/admin/records',
        body: `
          <p><a href="/admin/records">&larr; Back to records</a></p>
          <h2>Record: ${escapeHtml(record.isbn ?? `#${record.id}`)}</h2>
          <p class="muted">User: ${escapeHtml(record.user_email ?? '—')} &middot; Status: ${escapeHtml(record.status)} &middot; Created: ${new Date(record.created_at).toLocaleString()}</p>
          <h3>MARC text</h3>
          <pre>${escapeHtml(record.marc_text ?? '(no marc_text recorded)')}</pre>
          <h3>Edit history</h3>
          <table>
            <thead><tr><th>When</th><th>User prompt</th></tr></thead>
            <tbody>${editsHtml || '<tr><td colspan="2" class="muted">No edits recorded.</td></tr>'}</tbody>
          </table>
        `,
      })
    );
  })
);

// ---------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------

router.get(
  '/usage',
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`
      SELECT provider,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days') AS calls_7d,
        COALESCE(SUM(tokens_used) FILTER (WHERE created_at >= now() - interval '7 days'), 0) AS tokens_7d,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days') AS calls_30d,
        COALESCE(SUM(tokens_used) FILTER (WHERE created_at >= now() - interval '30 days'), 0) AS tokens_30d
      FROM api_usage
      GROUP BY provider
      ORDER BY provider
    `);

    const tableRows = rows
      .map(
        (row) => `<tr>
          <td>${escapeHtml(row.provider)}</td>
          <td>${row.calls_7d}</td>
          <td>${Number(row.tokens_7d).toLocaleString()}</td>
          <td>${row.calls_30d}</td>
          <td>${Number(row.tokens_30d).toLocaleString()}</td>
        </tr>`
      )
      .join('');

    res.send(
      layout({
        title: 'Usage',
        activeHref: '/admin/usage',
        body: `
          <h2>API usage</h2>
          <p class="lede">Estimated tokens are whatever each provider call logged to api_usage.tokens_used; not a billing figure.</p>
          <div class="panel table-wrap">
          <table>
            <thead><tr><th>Provider</th><th>Calls (7d)</th><th>Tokens (7d)</th><th>Calls (30d)</th><th>Tokens (30d)</th></tr></thead>
            <tbody>${tableRows || '<tr><td colspan="5" class="muted">No API usage recorded yet.</td></tr>'}</tbody>
          </table>
          </div>
        `,
      })
    );
  })
);

// ---------------------------------------------------------------------
// Rules (read-only)
// ---------------------------------------------------------------------

router.get(
  '/rules',
  asyncHandler(async (_req, res) => {
    let ruleProfile;
    let fieldRules;
    let readError = null;
    try {
      ruleProfile = JSON.parse(fs.readFileSync(path.join(RULES_DIR, 'rule_profile.json'), 'utf8'));
      fieldRules = JSON.parse(fs.readFileSync(path.join(RULES_DIR, 'marc_field_rules.json'), 'utf8'));
    } catch (error) {
      readError = error.message;
    }

    if (readError) {
      return res.send(
        layout({
          title: 'Rules',
          activeHref: '/admin/rules',
          body: `<h2>Rules</h2><div class="error">Could not load rule files: ${escapeHtml(readError)}</div>`,
        })
      );
    }

    const tagRows = fieldRules
      .map((rule) => `<tr><td>${escapeHtml(rule.tag)}</td><td>${escapeHtml(rule.field_name)}</td></tr>`)
      .join('');

    res.send(
      layout({
        title: 'Rules',
        activeHref: '/admin/rules',
        body: `
          <h2>Cataloguing standard</h2>
          <div class="panel table-wrap">
          <table>
            <tbody>
              <tr><th>Standard</th><td>${escapeHtml(ruleProfile.cataloguing_standard)}</td></tr>
              <tr><th>DDC edition default</th><td>${escapeHtml(ruleProfile.ddc_edition_default ?? '(not set)')}</td></tr>
              <tr><th>ILS</th><td>${escapeHtml(ruleProfile.ils)}</td></tr>
              <tr><th>Notes</th><td>${escapeHtml(ruleProfile.notes ?? '—')}</td></tr>
            </tbody>
          </table>
          </div>
          <h2>MARC tags with rules defined (${fieldRules.length})</h2>
          <div class="panel table-wrap">
          <table>
            <thead><tr><th>Tag</th><th>Field name</th></tr></thead>
            <tbody>${tagRows}</tbody>
          </table>
          </div>
          <p class="muted">Rule content itself lives in backend/rules/ -- this is a read-only sanity-check view; editing rules via the UI is a future task.</p>
        `,
      })
    );
  })
);

export default router;
