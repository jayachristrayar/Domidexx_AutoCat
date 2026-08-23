import crypto from 'crypto';
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
  setUserActive,
  setUserStatus,
  updateUserAccess,
  deleteUser,
  UserAlreadyExistsError,
  UserNotFoundError,
} from '../services/userService.js';
import {
  getAllMarcRules,
  getRuleProfile,
  getSeriesPolicy,
} from '../services/marcRuleRegistry.js';
import {
  listFrameworks,
  getFrameworkFieldTree,
  setFieldSetting,
  setSubfieldSetting,
} from '../services/marcFrameworkService.js';

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
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/admin.css" />
<link rel="icon" href="/logo/logo-32.png" />
</head>
<body>
<div class="login-shell">
  <form class="login-card" method="POST" action="/admin/login">
    <div class="login-brand">
      <img src="/logo/logo-64.png" width="52" height="52" alt="Domidexx AutoCat logo" />
      <div>
        <h1><span class="brand-d">D</span>omidexx AutoCat</h1>
        <p>Structuring the Unseen</p>
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
  { href: '/admin/frameworks', label: 'MARC Frameworks' },
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
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/admin.css" />
<link rel="icon" href="/logo/logo-32.png" />
</head>
<body>
<header class="topbar">
  <a class="brand" href="/admin">
    <img src="/logo/logo-64.png" width="40" height="40" alt="Domidexx AutoCat logo" />
    <span class="brand-text">
      <strong><span class="brand-d">D</span>omidexx AutoCat</strong>
      <span>Structuring the Unseen</span>
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
  device_limit: z.coerce.number().int().min(1).max(50).default(2),
  expires_at: z.string().optional(),
});

function formatExpiry(value) {
  if (!value) return 'No expiry';
  return new Date(value).toLocaleString();
}

function accessStatus(user) {
  if (user.status === 'PENDING') return { label: 'Pending activation', className: 'badge-warn' };
  if (user.status === 'REJECTED') return { label: 'Rejected', className: 'badge-off' };
  if (user.status === 'DISABLED' || !user.is_active) return { label: 'Disabled', className: 'badge-off' };
  if (user.expires_at && new Date(user.expires_at) < new Date()) {
    return { label: 'Expired', className: 'badge-warn' };
  }
  return { label: 'Active', className: 'badge-ok' };
}

// The action(s) offered per account status -- an admin can only take the
// transitions that make sense from where the account currently is.
// PENDING accounts get Approve/Reject; anything else gets the existing
// Activate/Deactivate toggle (Reactivate is just Activate on a
// REJECTED/DISABLED account -- same transition, same button).
function statusActionsHtml(user) {
  if (user.status === 'PENDING') {
    return `
      <form class="inline" method="POST" action="/admin/users/${user.id}/approve">
        <button type="submit" class="btn">Approve</button>
      </form>
      <form class="inline" method="POST" action="/admin/users/${user.id}/reject" onsubmit="return confirm('Reject this signup request?');">
        <button type="submit" class="btn btn-danger-outline">Reject</button>
      </form>
    `;
  }
  return `
    <form class="inline" method="POST" action="/admin/users/${user.id}/${user.is_active ? 'deactivate' : 'activate'}">
      <button type="submit" class="btn ${user.is_active ? 'btn-gold' : 'btn'}">${user.is_active ? 'Deactivate' : 'Reactivate'}</button>
    </form>
  `;
}

function toExpiresAtOrNull(raw) {
  if (!raw || !String(raw).trim()) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function renderUsersPage({ users, formError, notice }) {
  const rows = users
    .map((user) => {
      const lastSeen = user.last_seen_at
        ? new Date(user.last_seen_at).toLocaleString()
        : '<span class="muted">never</span>';
      const status = accessStatus(user);
      const expiryValue = user.expires_at
        ? new Date(user.expires_at).toISOString().slice(0, 16)
        : '';
      return `<tr>
        <td>
          <strong>${escapeHtml(user.email)}</strong>
          <div class="muted" style="font-size:0.8rem">#${user.id} · ${escapeHtml(formatExpiry(user.expires_at))}</div>
          <div style="margin-top:6px"><span class="badge ${status.className}">${status.label}</span></div>
        </td>
        <td>${escapeHtml(user.institution_name ?? '—')}</td>
        <td><span class="badge">${escapeHtml(user.subscription_tier)}</span></td>
        <td>${user.device_limit}</td>
        <td>${new Date(user.created_at).toLocaleDateString()}</td>
        <td>${lastSeen}</td>
        <td>
          <div class="user-actions">
            <form class="inline" method="POST" action="/admin/users/${user.id}/tier">
              <select name="tier">
                <option value="free" ${user.subscription_tier === 'free' ? 'selected' : ''}>free</option>
                <option value="paid" ${user.subscription_tier === 'paid' ? 'selected' : ''}>paid</option>
              </select>
              <button type="submit" class="btn">Save tier</button>
            </form>
            <form class="inline" method="POST" action="/admin/users/${user.id}/access">
              <input type="number" name="device_limit" min="1" max="50" value="${user.device_limit}" title="Device limit" required />
              <input type="datetime-local" name="expires_at" value="${escapeHtml(expiryValue)}" title="Expiry (leave blank for none)" />
              <button type="submit" class="btn btn-secondary">Save access</button>
            </form>
            <form class="inline" method="POST" action="/admin/users/${user.id}/password">
              <input type="password" name="password" minlength="8" placeholder="New password" required autocomplete="new-password" />
              <button type="submit" class="btn btn-secondary">Set password</button>
            </form>
            ${statusActionsHtml(user)}
            <form class="inline" method="POST" action="/admin/users/${user.id}/delete" onsubmit="return confirm('Delete this account permanently? MARC records are kept but detached.');">
              <button type="submit" class="btn btn-danger-outline">Delete account</button>
            </form>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  return layout({
    title: 'Users',
    activeHref: '/admin/users',
    body: `
      <h2>Users</h2>
      <p class="lede">Activate or deactivate accounts, set device limits and expiry periods, reset passwords, or delete accounts.</p>
      ${formError ? `<div class="error">${escapeHtml(formError)}</div>` : ''}
      ${notice ? `<div class="success">${escapeHtml(notice)}</div>` : ''}
      <div class="panel table-wrap">
        <table>
          <thead><tr><th>Email / status</th><th>Institution</th><th>Tier</th><th>Devices</th><th>Created</th><th>Last active</th><th>Actions</th></tr></thead>
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
          <label><span>Device limit</span><input type="number" name="device_limit" min="1" max="50" value="2" required /></label>
          <label><span>Expiry (optional)</span><input type="datetime-local" name="expires_at" /></label>
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
      `SELECT u.id, u.email, u.subscription_tier, u.created_at, u.is_active, u.status, u.device_limit, u.expires_at,
              i.name AS institution_name,
              MAX(s.last_seen_at) AS last_seen_at
       FROM users u
       LEFT JOIN institutions i ON i.id = u.institution_id
       LEFT JOIN sessions s ON s.user_id = u.id
       GROUP BY u.id, i.name
       ORDER BY (u.status = 'PENDING') DESC, u.created_at DESC`
    );

    const notice = req.query.created
      ? 'User created.'
      : req.query.password_reset
        ? 'Password updated. Existing extension sessions for that user were signed out.'
        : req.query.approved
          ? 'Account approved and activated.'
          : req.query.rejected
            ? 'Signup request rejected.'
            : req.query.activated
              ? 'Account activated.'
              : req.query.deactivated
                ? 'Account deactivated and sessions cleared.'
                : req.query.access
                  ? 'Device limit / expiry updated.'
                  : req.query.deleted
                    ? 'Account deleted.'
                    : null;

    res.send(
      renderUsersPage({
        users,
        formError: req.query.error || null,
        notice,
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

    const expiresAt = toExpiresAtOrNull(parsed.data.expires_at);
    if (expiresAt === undefined) {
      return res.redirect(`/admin/users?error=${encodeURIComponent('Invalid expiry date.')}`);
    }

    try {
      await createUser({
        email: parsed.data.email,
        password: parsed.data.password,
        institutionSlug: parsed.data.institution_slug,
        subscriptionTier: parsed.data.subscription_tier,
        deviceLimit: parsed.data.device_limit,
        expiresAt,
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

const accessSchema = z.object({
  device_limit: z.coerce.number().int().min(1).max(50),
  expires_at: z.string().optional(),
});

router.post(
  '/users/:id/access',
  asyncHandler(async (req, res) => {
    const parsed = accessSchema.safeParse(req.body);
    const userId = Number(req.params.id);
    if (!parsed.success || !Number.isInteger(userId)) {
      return res.redirect(`/admin/users?error=${encodeURIComponent('Invalid access settings.')}`);
    }

    const expiresAt = toExpiresAtOrNull(parsed.data.expires_at);
    if (expiresAt === undefined) {
      return res.redirect(`/admin/users?error=${encodeURIComponent('Invalid expiry date.')}`);
    }

    try {
      await updateUserAccess({
        userId,
        deviceLimit: parsed.data.device_limit,
        expiresAt,
      });
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        return res.redirect(`/admin/users?error=${encodeURIComponent('User not found.')}`);
      }
      throw error;
    }

    res.redirect('/admin/users?access=1');
  })
);

// Approve/Reject -- the PENDING-account activation workflow (product spec
// section 3). Only reachable behind requireAdminSession (applied to the
// whole /admin router below); a librarian's session token is a completely
// different credential and is never accepted here.
router.post(
  '/users/:id/approve',
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) {
      return res.redirect(`/admin/users?error=${encodeURIComponent('Invalid user.')}`);
    }
    try {
      await setUserStatus(userId, 'ACTIVE');
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        return res.redirect(`/admin/users?error=${encodeURIComponent('User not found.')}`);
      }
      throw error;
    }
    res.redirect('/admin/users?approved=1');
  })
);

router.post(
  '/users/:id/reject',
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) {
      return res.redirect(`/admin/users?error=${encodeURIComponent('Invalid user.')}`);
    }
    try {
      await setUserStatus(userId, 'REJECTED');
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        return res.redirect(`/admin/users?error=${encodeURIComponent('User not found.')}`);
      }
      throw error;
    }
    res.redirect('/admin/users?rejected=1');
  })
);

router.post(
  '/users/:id/activate',
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) {
      return res.redirect(`/admin/users?error=${encodeURIComponent('Invalid user.')}`);
    }
    try {
      await setUserActive(userId, true);
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        return res.redirect(`/admin/users?error=${encodeURIComponent('User not found.')}`);
      }
      throw error;
    }
    res.redirect('/admin/users?activated=1');
  })
);

router.post(
  '/users/:id/deactivate',
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) {
      return res.redirect(`/admin/users?error=${encodeURIComponent('Invalid user.')}`);
    }
    try {
      await setUserActive(userId, false);
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        return res.redirect(`/admin/users?error=${encodeURIComponent('User not found.')}`);
      }
      throw error;
    }
    res.redirect('/admin/users?deactivated=1');
  })
);

router.post(
  '/users/:id/delete',
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) {
      return res.redirect(`/admin/users?error=${encodeURIComponent('Invalid user.')}`);
    }
    try {
      await deleteUser(userId);
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        return res.redirect(`/admin/users?error=${encodeURIComponent('User not found.')}`);
      }
      throw error;
    }
    res.redirect('/admin/users?deleted=1');
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
          <h3 class="panel-title">Library user access controls</h3>
          <p>On the Users page you can:</p>
          <ul>
            <li><strong>Activate / Deactivate</strong> an account (deactivation signs them out immediately)</li>
            <li><strong>Device limit</strong> — max concurrent extension devices</li>
            <li><strong>Expiry period</strong> — optional access end date/time</li>
            <li><strong>Set password</strong> or <strong>Delete account</strong></li>
          </ul>
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
          <p>Header uses the Domidexx AutoCat mark with a transparent background (no white tile), aligned to the <a href="https://domidexx.in" target="_blank" rel="noreferrer">domidexx.in</a> blue palette.</p>
          <img src="/logo/logo-128.png" width="96" height="96" alt="Domidexx AutoCat logo preview" style="background:transparent" />
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
// Rules (read-only) — runtime registry (same loader as builder/validator)
// ---------------------------------------------------------------------

router.get(
  '/rules',
  asyncHandler(async (_req, res) => {
    let ruleProfile;
    let fieldRules;
    let seriesPolicy;
    let readError = null;
    try {
      ruleProfile = getRuleProfile();
      fieldRules = getAllMarcRules();
      seriesPolicy = getSeriesPolicy();
    } catch (error) {
      readError = error.message;
    }

    if (readError) {
      return res.send(
        layout({
          title: 'Rules',
          activeHref: '/admin/rules',
          body: `<h2>Rules</h2><div class="error">Could not load rule registry: ${escapeHtml(readError)}</div>`,
        })
      );
    }

    const flag = (value) => (value ? 'yes' : 'no');
    const tagRows = fieldRules
      .map(
        (rule) => `<tr>
          <td>${escapeHtml(rule.tag)}</td>
          <td>${escapeHtml(rule.label)}</td>
          <td><code>${escapeHtml(rule.status)}</code></td>
          <td>${escapeHtml(rule.generation_method ?? '—')}</td>
          <td>${rule.validation ? (rule.validation.incomplete ? 'partial' : 'yes') : '—'}</td>
          <td>${flag(rule.ai_assisted)}</td>
          <td>${flag(rule.evidence_required)}</td>
          <td>${flag(rule.koha_supported)}</td>
        </tr>`
      )
      .join('');

    const seriesBlock = seriesPolicy
      ? `<h2>Series policy</h2>
          <div class="panel table-wrap">
          <table>
            <tbody>
              <tr><th>Target framework field</th><td>${escapeHtml(seriesPolicy.target_framework_field)}</td></tr>
              <tr><th>Status</th><td><code>${escapeHtml(seriesPolicy.status)}</code></td></tr>
              <tr><th>Do not silently replace with</th><td>${escapeHtml(seriesPolicy.do_not_silently_replace_with)}</td></tr>
              <tr><th>Notes</th><td>${escapeHtml(seriesPolicy.notes ?? '—')}</td></tr>
            </tbody>
          </table>
          </div>`
      : '';

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
          ${seriesBlock}
          <h2>MARC runtime rule registry (${fieldRules.length})</h2>
          <div class="panel table-wrap">
          <table>
            <thead><tr>
              <th>Tag</th><th>Label</th><th>Status</th><th>Generation</th>
              <th>Validation</th><th>AI</th><th>Evidence</th><th>Koha</th>
            </tr></thead>
            <tbody>${tagRows}</tbody>
          </table>
          </div>
          <p class="muted">Loaded via marcRuleRegistry (marc_runtime_rules.json). Cataloguing prose from marc_field_rules.json is attached by tag. Editing rules via the UI is a future task.</p>
        `,
      })
    );
  })
);

// ---------------------------------------------------------------------
// MARC Frameworks (General MARC21 vocabulary + custom framework config)
// ---------------------------------------------------------------------

const CONTROL_CODE_TOKEN = '_control_';
function encodeSubfieldCode(code) {
  return code == null ? CONTROL_CODE_TOKEN : encodeURIComponent(code);
}
function decodeSubfieldCode(param) {
  return param === CONTROL_CODE_TOKEN ? null : decodeURIComponent(param);
}

router.get(
  '/frameworks',
  asyncHandler(async (_req, res) => {
    const frameworks = await listFrameworks();
    const rows = frameworks
      .map(
        (fw) => `<tr>
          <td><a href="/admin/frameworks/${escapeHtml(fw.code)}">${escapeHtml(fw.name)}</a></td>
          <td><code>${escapeHtml(fw.code)}</code></td>
          <td><span class="badge ${fw.framework_type === 'GENERAL' ? 'badge-warn' : 'badge-ok'}">${escapeHtml(fw.framework_type)}</span></td>
          <td>${escapeHtml(fw.description ?? '—')}</td>
        </tr>`
      )
      .join('');
    res.send(
      layout({
        title: 'MARC Frameworks',
        activeHref: '/admin/frameworks',
        body: `
          <h2>MARC Frameworks</h2>
          <p class="lede">Two separate layers: <strong>General MARC21</strong> is the master vocabulary (what a tag/subfield means); a <strong>Custom</strong> framework is a library's own selection of enabled fields, required flags, and defaults on top of it. Disabling or requiring a field in a custom framework never changes General MARC21.</p>
          <div class="panel table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Code</th><th>Type</th><th>Description</th></tr></thead>
              <tbody>${rows || '<tr><td colspan="4" class="muted">No frameworks seeded yet — run <code>npm run seed:marc-frameworks</code>.</td></tr>'}</tbody>
            </table>
          </div>
        `,
      })
    );
  })
);

function frameworkFieldRow(frameworkCode, field) {
  const subfieldRows = field.subfields
    .map(
      (sf) => `<tr class="framework-subfield-row">
        <td></td>
        <td><code>$${sf.code == null ? '(control value)' : escapeHtml(sf.code)}</code></td>
        <td>${escapeHtml(sf.label)}</td>
        <td>
          <form method="POST" action="/admin/frameworks/${escapeHtml(frameworkCode)}/fields/${escapeHtml(field.tag)}/subfields/${encodeSubfieldCode(sf.code)}" class="inline">
            <label><input type="checkbox" name="enabled" ${sf ? 'checked' : ''} value="1" /> Enabled</label>
            <label><input type="checkbox" name="required" ${sf.required ? 'checked' : ''} value="1" /> Required</label>
            <input type="text" name="default_value" value="${escapeHtml(sf.default_value ?? '')}" placeholder="Default value" size="20" />
            <button type="submit" class="btn btn-secondary">Save</button>
          </form>
        </td>
      </tr>`
    )
    .join('');

  return `
    <tr class="framework-field-row">
      <td><code>${escapeHtml(field.tag)}</code></td>
      <td>${escapeHtml(field.label)} ${field.is_koha_field ? '<span class="badge badge-warn">Koha-specific</span>' : ''} ${field.minimal_definition ? '<span class="badge badge-off">minimal definition</span>' : ''}</td>
      <td>${escapeHtml(field.section ?? '—')}</td>
      <td>${field.repeatable ? 'Yes' : 'No'}</td>
      <td>
        <form method="POST" action="/admin/frameworks/${escapeHtml(frameworkCode)}/fields/${escapeHtml(field.tag)}" class="inline">
          <label><input type="checkbox" name="enabled" checked value="1" /> Enabled</label>
          <label><input type="checkbox" name="required" ${field.required ? 'checked' : ''} value="1" /> Required</label>
          <input type="text" name="section" value="${escapeHtml(field.section ?? '')}" placeholder="Section tab" size="4" />
          <button type="submit" class="btn btn-secondary">Save field</button>
        </form>
      </td>
    </tr>
    ${subfieldRows}
  `;
}

router.get(
  '/frameworks/:code',
  asyncHandler(async (req, res) => {
    const tree = await getFrameworkFieldTree(req.params.code, { onlyEnabled: false });
    if (!tree) {
      return res.status(404).send(
        layout({ title: 'MARC Frameworks', activeHref: '/admin/frameworks', body: `<div class="error">Unknown framework: ${escapeHtml(req.params.code)}</div>` })
      );
    }

    const bySection = {};
    for (const field of tree.fields) (bySection[field.section ?? 'UNSPECIFIED'] ??= []).push(field);
    const sectionKeys = Object.keys(bySection).sort();

    const sectionsHtml = sectionKeys
      .map(
        (section) => `
        <details ${section === sectionKeys[0] ? 'open' : ''}>
          <summary><strong>Section ${escapeHtml(section)}</strong> (${bySection[section].length} field${bySection[section].length === 1 ? '' : 's'})</summary>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Tag</th><th>Field</th><th>Section</th><th>Repeatable</th><th>Settings</th></tr></thead>
              <tbody>${bySection[section].map((f) => frameworkFieldRow(tree.framework.code, f)).join('')}</tbody>
            </table>
          </div>
        </details>
      `
      )
      .join('');

    res.send(
      layout({
        title: tree.framework.name,
        activeHref: '/admin/frameworks',
        body: `
          <h2>${escapeHtml(tree.framework.name)} <span class="badge ${tree.framework.framework_type === 'GENERAL' ? 'badge-warn' : 'badge-ok'}">${escapeHtml(tree.framework.framework_type)}</span></h2>
          <p class="lede">${escapeHtml(tree.framework.description ?? '')}</p>
          <p><a href="/admin/frameworks">&larr; All frameworks</a> · <a href="/api/marc-frameworks/${escapeHtml(tree.framework.code)}/export">Export JSON</a></p>
          ${tree.framework.framework_type === 'GENERAL' ? '<div class="notice">This is the master MARC21 vocabulary. Changes here should be rare — most day-to-day configuration (required fields, defaults, enabling/disabling) belongs on a custom framework instead.</div>' : ''}
          ${sectionsHtml}
        `,
      })
    );
  })
);

const fieldSettingSchema = z.object({
  enabled: z.string().optional(),
  required: z.string().optional(),
  section: z.string().optional(),
});

router.post(
  '/frameworks/:code/fields/:tag',
  asyncHandler(async (req, res) => {
    const parsed = fieldSettingSchema.safeParse(req.body);
    if (!parsed.success) return res.redirect(`/admin/frameworks/${req.params.code}?error=1`);
    await setFieldSetting(req.params.code, req.params.tag, {
      enabled: Boolean(parsed.data.enabled),
      required: Boolean(parsed.data.required),
      section: parsed.data.section || null,
    });
    res.redirect(`/admin/frameworks/${req.params.code}`);
  })
);

const subfieldSettingSchema = z.object({
  enabled: z.string().optional(),
  required: z.string().optional(),
  default_value: z.string().optional(),
});

router.post(
  '/frameworks/:code/fields/:tag/subfields/:subfieldCode',
  asyncHandler(async (req, res) => {
    const parsed = subfieldSettingSchema.safeParse(req.body);
    if (!parsed.success) return res.redirect(`/admin/frameworks/${req.params.code}?error=1`);
    await setSubfieldSetting(req.params.code, req.params.tag, decodeSubfieldCode(req.params.subfieldCode), {
      enabled: Boolean(parsed.data.enabled),
      required: Boolean(parsed.data.required),
      default_value: parsed.data.default_value || null,
    });
    res.redirect(`/admin/frameworks/${req.params.code}`);
  })
);

export default router;
