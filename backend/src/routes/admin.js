import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import pool, { checkDatabase, getConfigStatus } from '../db/index.js';
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
  setSubscriptionTier,
  updateUserAccess,
  deleteUser,
  enableOpenAiAccess,
  disableOpenAiAccess,
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
import { usageSummary, listUsage, listUsageUsers } from '../services/usageService.js';

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
    let userStatusRows, marcRecordRows, ddcRows, ddcCount, usage, dbUp;
    try {
      [{ rows: userStatusRows }, { rows: marcRecordRows }, { rows: ddcRows }, usage, dbUp] = await Promise.all([
        pool.query(`SELECT status, count(*) FROM users GROUP BY status`),
        pool.query(`SELECT status, count(*) FROM marc_records GROUP BY status`),
        pool.query(`SELECT count(*) FROM ddc_decisions`),
        usageSummary(),
        checkDatabase().catch(() => false),
      ]);
      ddcCount = Number(ddcRows[0]?.count ?? 0);
    } catch (error) {
      error.message = `Dashboard query failed: ${error.message}`;
      throw error;
    }

    const byStatus = Object.fromEntries(userStatusRows.map((r) => [r.status, Number(r.count)]));
    const totalUsers = userStatusRows.reduce((sum, r) => sum + Number(r.count), 0);
    const totalMarcRecords = marcRecordRows.reduce((sum, r) => sum + Number(r.count), 0);
    const config = getConfigStatus();

    const statTile = (label, value) => `<div class="panel stat-panel"><span class="stat-label">${escapeHtml(label)}</span><span class="stat-value">${value}</span></div>`;
    const statusRow = (label, ok, detail) => `<div class="status-row"><span class="status-dot ${ok ? '' : 'off'}"></span><span>${escapeHtml(label)}</span><span class="muted">${escapeHtml(detail)}</span></div>`;

    res.send(
      layout({
        title: 'Overview',
        activeHref: '/admin',
        body: `
          <h2>Overview</h2>
          <p class="lede">Real counts from Postgres -- no placeholder numbers.</p>

          <h3 class="panel-title">Users</h3>
          <div class="grid-4">
            ${statTile('Total', totalUsers)}
            ${statTile('Active', byStatus.ACTIVE ?? 0)}
            ${statTile('Pending', byStatus.PENDING ?? 0)}
            ${statTile('Disabled', (byStatus.DISABLED ?? 0) + (byStatus.REJECTED ?? 0))}
          </div>

          <h3 class="panel-title">Cataloguing</h3>
          <div class="grid-4">
            ${statTile('MARC records completed', marcRecordRows.find((r) => r.status === 'COMPLETED')?.count ?? 0)}
            ${statTile('MARC generations (total)', totalMarcRecords)}
            ${statTile('DDC analyses', ddcCount)}
            ${statTile('Needs review', marcRecordRows.find((r) => r.status === 'NEEDS_REVIEW')?.count ?? 0)}
          </div>

          <h3 class="panel-title">AI requests</h3>
          <div class="grid-4">
            ${statTile('Total', usage.totalRequests)}
            ${statTile('NVIDIA', usage.nvidiaRequests)}
            ${statTile('OpenAI', usage.openaiRequests)}
            ${statTile('Active users', usage.activeUsers)}
          </div>

          <div class="panel">
            <h3 class="panel-title">System</h3>
            ${statusRow('Backend', true, 'Running')}
            ${statusRow('Database', dbUp, dbUp ? 'Connected' : 'Unreachable')}
            ${statusRow('NVIDIA provider', config.NVIDIA_API_KEY === 'SET', config.NVIDIA_API_KEY === 'SET' ? 'Configured' : 'Not configured')}
            ${statusRow('OpenAI provider', config.OPENAI_API_KEY === 'SET', config.OPENAI_API_KEY === 'SET' ? 'Configured' : 'Not configured')}
          </div>

          <div class="panel">
            <h3 class="panel-title">Quick links</h3>
            <p class="muted"><a href="/admin/users">Manage users</a> · <a href="/admin/records">Review records</a> · <a href="/admin/usage">Usage</a> · <a href="/health">System health JSON</a></p>
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

// Manage drawer (product spec section 6): a native <dialog> per user, so
// every action stays a plain HTML form POST like the rest of this
// no-build-step admin app -- no client JS framework, no fetch/AJAX. Each
// dialog is opened by its row's single "Manage" button
// (dialog.showModal(), a couple of bytes of inline JS) and closed by its
// own Close button; the browser's native <dialog> backdrop/Escape handling
// covers the rest for free.
function manageDialogHtml(user) {
  const modelAccess = user.model_access ?? ['NVIDIA'];
  const hasOpenAi = modelAccess.includes('OPENAI');
  const status = accessStatus(user);
  const expiryValue = user.expires_at ? new Date(user.expires_at).toISOString().slice(0, 16) : '';
  const lastSeen = user.last_seen_at ? new Date(user.last_seen_at).toLocaleString() : 'Never';

  return `
    <dialog id="manage-${user.id}" class="manage-dialog">
      <form method="dialog"><button type="submit" class="dialog-close" aria-label="Close">&times;</button></form>
      <h3 class="panel-title">${escapeHtml(user.autocat_user_id ?? '—')}</h3>
      <dl class="manage-facts">
        <dt>Email</dt><dd>${escapeHtml(user.email)}</dd>
        <dt>Institution</dt><dd>${escapeHtml(user.institution_name ?? '—')}</dd>
        <dt>Subscription</dt><dd>${escapeHtml(user.subscription_tier.toUpperCase())}</dd>
        <dt>Status</dt><dd><span class="badge ${status.className}">${status.label}</span></dd>
        <dt>Created</dt><dd>${new Date(user.created_at).toLocaleDateString()}</dd>
        <dt>Last active</dt><dd>${escapeHtml(lastSeen)}</dd>
      </dl>

      <h4 class="manage-section-title">AI access</h4>
      <dl class="manage-facts">
        <dt>NVIDIA</dt><dd><span class="badge badge-ok">Enabled</span></dd>
        <dt>OpenAI</dt><dd><span class="badge ${hasOpenAi ? 'badge-ok' : 'badge-off'}">${hasOpenAi ? 'Enabled' : 'Disabled'}</span></dd>
      </dl>
      <p class="muted" style="font-size:0.82rem">Driven automatically by Subscription -- FREE enables NVIDIA only, PAID enables both.</p>

      <h4 class="manage-section-title">Account</h4>
      <form class="stack-form" method="POST" action="/admin/users/${user.id}/tier">
        <label><span>Change subscription</span>
          <select name="tier">
            <option value="free" ${user.subscription_tier === 'free' ? 'selected' : ''}>FREE</option>
            <option value="paid" ${user.subscription_tier === 'paid' ? 'selected' : ''}>PAID</option>
          </select>
        </label>
        <button type="submit" class="btn">Save subscription</button>
      </form>
      <form class="stack-form" method="POST" action="/admin/users/${user.id}/access">
        <label><span>Device limit</span><input type="number" name="device_limit" min="1" max="50" value="${user.device_limit}" required /></label>
        <label><span>Expiry (optional)</span><input type="datetime-local" name="expires_at" value="${escapeHtml(expiryValue)}" /></label>
        <button type="submit" class="btn btn-secondary">Save access</button>
      </form>
      <form class="stack-form" method="POST" action="/admin/users/${user.id}/password">
        <label><span>Reset password</span><input type="password" name="password" minlength="8" placeholder="New password" required autocomplete="new-password" /></label>
        <button type="submit" class="btn btn-secondary">Reset password</button>
      </form>

      <h4 class="manage-section-title">Actions</h4>
      <div class="manage-actions">
        ${statusActionsHtml(user)}
        <form method="POST" action="/admin/users/${user.id}/delete" onsubmit="return confirm('Delete this account permanently? MARC records are kept but detached.');">
          <button type="submit" class="btn btn-danger-outline">Delete account</button>
        </form>
      </div>
    </dialog>
  `;
}

function renderUsersPage({ users, formError, notice }) {
  const rows = users
    .map((user) => {
      const lastSeen = user.last_seen_at ? new Date(user.last_seen_at).toLocaleString() : 'Never';
      const status = accessStatus(user);
      const modelAccess = user.model_access ?? ['NVIDIA'];
      const aiAccessLabel = modelAccess.includes('OPENAI') ? 'NVIDIA + OpenAI' : 'NVIDIA';
      return `<tr>
        <td>${escapeHtml(user.autocat_user_id ?? '—')}</td>
        <td>${escapeHtml(user.email)}</td>
        <td>${escapeHtml(user.institution_name ?? '—')}</td>
        <td><span class="badge">${escapeHtml(user.subscription_tier.toUpperCase())}</span></td>
        <td>${escapeHtml(aiAccessLabel)}</td>
        <td><span class="badge ${status.className}">${status.label}</span></td>
        <td>${escapeHtml(lastSeen)}</td>
        <td><button type="button" class="btn btn-secondary" onclick="document.getElementById('manage-${user.id}').showModal()">Manage</button></td>
      </tr>${manageDialogHtml(user)}`;
    })
    .join('');

  return layout({
    title: 'Users',
    activeHref: '/admin/users',
    body: `
      <h2>Users</h2>
      <p class="lede">Create accounts on the left; manage an existing one from the list on the right.</p>
      ${formError ? `<div class="error">${escapeHtml(formError)}</div>` : ''}
      ${notice ? `<div class="success">${escapeHtml(notice)}</div>` : ''}
      <div class="users-layout">
        <div class="panel users-create">
          <h3 class="panel-title">Create user</h3>
          <form class="stack-form" method="POST" action="/admin/users">
            <label><span>Email</span><input type="email" name="email" required /></label>
            <label><span>Password</span><input type="password" name="password" minlength="8" required autocomplete="new-password" /></label>
            <label><span>Institution</span><input type="text" name="institution_slug" placeholder="e.g. riverside-public-library" required /></label>
            <label><span>Subscription</span>
              <select name="subscription_tier">
                <option value="free">FREE</option>
                <option value="paid">PAID</option>
              </select>
            </label>
            <label><span>Device limit</span><input type="number" name="device_limit" min="1" max="50" value="2" required /></label>
            <label><span>Expiry (optional)</span><input type="datetime-local" name="expires_at" /></label>
            <button class="btn full" type="submit">Create user</button>
          </form>
        </div>
        <div class="panel users-list table-wrap">
          <h3 class="panel-title">Users (${users.length})</h3>
          <table>
            <thead><tr><th>ID</th><th>Email</th><th>Institution</th><th>Type</th><th>AI access</th><th>Status</th><th>Last active</th><th>Action</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="8" class="muted">No users yet.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    `,
  });
}

router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const { rows: users } = await pool.query(
      `SELECT u.id, u.email, u.subscription_tier, u.autocat_user_id, u.model_access,
              u.created_at, u.is_active, u.status, u.device_limit, u.expires_at,
              i.name AS institution_name,
              MAX(s.last_seen_at) AS last_seen_at
       FROM users u
       LEFT JOIN institutions i ON i.id = u.institution_id
       LEFT JOIN sessions s ON s.user_id = u.id
       GROUP BY u.id, i.name
       ORDER BY (u.status = 'PENDING') DESC, u.created_at DESC`
    );

    const notice = req.query.created
      ? `User created successfully. AutoCat ID: ${req.query.created}`
      : req.query.tier_updated
        ? 'Subscription updated -- AI access adjusted automatically.'
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
                    : req.query.openai_enabled
                      ? 'OpenAI access enabled for this account.'
                      : req.query.openai_disabled
                        ? 'OpenAI access disabled for this account.'
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

    let created;
    try {
      created = await createUser({
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

    // The AutoCat ID is generated entirely server-side (users.autocat_user_id's
    // sequence-backed column default) -- the admin never types or picks it;
    // this just echoes back what the database already assigned.
    res.redirect(`/admin/users?created=${encodeURIComponent(created.autocatUserId)}`);
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

    try {
      await setSubscriptionTier(userId, parsed.data.tier);
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        return res.redirect(`/admin/users?error=${encodeURIComponent('User not found.')}`);
      }
      throw error;
    }
    res.redirect('/admin/users?tier_updated=1');
  })
);

// Model access -- only reachable by an admin (this whole router is behind
// requireAdminSession above); a normal user has no route that can reach
// users.model_access at all (product spec section 8/18).
router.post(
  '/users/:id/model-access/enable-openai',
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) {
      return res.redirect(`/admin/users?error=${encodeURIComponent('Invalid user.')}`);
    }
    try {
      await enableOpenAiAccess(userId);
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        return res.redirect(`/admin/users?error=${encodeURIComponent('User not found.')}`);
      }
      throw error;
    }
    res.redirect('/admin/users?openai_enabled=1');
  })
);

router.post(
  '/users/:id/model-access/disable-openai',
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) {
      return res.redirect(`/admin/users?error=${encodeURIComponent('Invalid user.')}`);
    }
    try {
      await disableOpenAiAccess(userId);
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        return res.redirect(`/admin/users?error=${encodeURIComponent('User not found.')}`);
      }
      throw error;
    }
    res.redirect('/admin/users?openai_disabled=1');
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

router.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    const [dbUp, ruleProfile] = await Promise.all([checkDatabase().catch(() => false), Promise.resolve(getRuleProfile())]);
    const config = getConfigStatus();
    const statusRow = (label, ok, detail) => `<div class="status-row"><span class="status-dot ${ok ? '' : 'off'}"></span><span>${escapeHtml(label)}</span><span class="muted">${escapeHtml(detail)}</span></div>`;

    res.send(
      layout({
        title: 'Settings',
        activeHref: '/admin/settings',
        body: `
          <h2>Settings</h2>
          <p class="lede">Actual application configuration -- nothing here is a deployment instruction.</p>

          <div class="panel">
            <h3 class="panel-title">System</h3>
            ${statusRow('Backend', true, 'Running')}
            ${statusRow('Database', dbUp, dbUp ? 'Connected' : 'Unreachable')}
          </div>

          <div class="panel">
            <h3 class="panel-title">AI providers</h3>
            ${statusRow('NVIDIA', config.NVIDIA_API_KEY === 'SET', config.NVIDIA_API_KEY === 'SET' ? 'Configured' : 'Not configured')}
            ${statusRow('OpenAI', config.OPENAI_API_KEY === 'SET', config.OPENAI_API_KEY === 'SET' ? 'Configured' : 'Not configured')}
            <p class="muted" style="margin-top:10px">FREE accounts get NVIDIA only; PAID accounts get NVIDIA + OpenAI, applied automatically from the Users page.</p>
          </div>

          <div class="panel">
            <h3 class="panel-title">Cataloguing</h3>
            <dl class="manage-facts">
              <dt>Standard</dt><dd>${escapeHtml(ruleProfile.cataloguing_standard)}</dd>
              <dt>DDC edition</dt><dd>${escapeHtml(ruleProfile.ddc_edition_default)}</dd>
              <dt>ILS</dt><dd>${escapeHtml(ruleProfile.ils)}</dd>
            </dl>
            <p class="muted" style="margin-top:10px">Full field-by-field configuration is on the <a href="/admin/rules">Rules</a> and <a href="/admin/frameworks">MARC Frameworks</a> pages.</p>
          </div>

          <div class="panel">
            <h3 class="panel-title">Security</h3>
            ${statusRow('Admin session', config.ADMIN_PASSWORD === 'SET' && config.ADMIN_SESSION_SECRET === 'SET', config.ADMIN_PASSWORD === 'SET' && config.ADMIN_SESSION_SECRET === 'SET' ? 'Configured' : 'Incomplete')}
            <p class="muted" style="margin-top:10px">Library account status (Pending / Active / Rejected / Disabled), device limits, and password resets are managed per-account from the <a href="/admin/users">Users</a> page.</p>
          </div>

          <div class="panel">
            <h3 class="panel-title">Branding</h3>
            <img src="/logo/logo-128.png" width="72" height="72" alt="Domidexx AutoCat logo" style="background:transparent" />
          </div>
        `,
      })
    );
  })
);

// ---------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------

function extractTitleFromMarcJson(marcJson) {
  if (!Array.isArray(marcJson)) return null;
  const field245 = marcJson.find((field) => field.tag === '245');
  const subfieldA = field245?.subfields?.find((subfield) => subfield.code === 'a')?.value;
  return subfieldA ? subfieldA.replace(/[\s/:;,.]+$/, '') : null;
}

// The DDC number attached to this record, if 082$a was actually present
// (i.e. the DDC decision was approved before this generation) -- not every
// generated record has one (a NEEDS_REVIEW draft made before DDC approval
// won't), so the Records page must show that honestly rather than guessing.
function extractDdcFromMarcJson(marcJson) {
  if (!Array.isArray(marcJson)) return null;
  const field082 = marcJson.find((field) => field.tag === '082');
  return field082?.subfields?.find((subfield) => subfield.code === 'a')?.value ?? null;
}

function marcRecordDisplayId(id) {
  return `MARC-${String(id).padStart(4, '0')}`;
}

function recordStatusBadgeClass(status) {
  if (status === 'COMPLETED') return 'badge-ok';
  if (status === 'NEEDS_REVIEW') return 'badge-warn';
  return 'badge';
}

router.get(
  '/records',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const offset = (page - 1) * RECORDS_PAGE_SIZE;

    const [{ rows: records }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT r.id, r.isbn, r.marc_json, r.status, r.created_at, u.autocat_user_id
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
        const ddc = extractDdcFromMarcJson(record.marc_json);
        return `<tr>
          <td><a href="/admin/records/${record.id}">${marcRecordDisplayId(record.id)}</a></td>
          <td>${escapeHtml(record.isbn ?? '—')}</td>
          <td>${title}</td>
          <td>${ddc ? escapeHtml(ddc) : '<span class="muted">—</span>'}</td>
          <td>${escapeHtml(record.autocat_user_id ?? '—')}</td>
          <td><span class="badge ${recordStatusBadgeClass(record.status)}">${escapeHtml(record.status)}</span></td>
          <td>${new Date(record.created_at).toLocaleDateString()}</td>
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
          <p class="lede">${total} MARC record${total === 1 ? '' : 's'} generated by AutoCat. An ISBN lookup on its own is never stored here -- only an actual "Generate MARC" action is.</p>
          <div class="panel table-wrap">
          <table>
            <thead><tr><th>MARC ID</th><th>ISBN</th><th>Title</th><th>DDC</th><th>User ID</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="7" class="muted">No MARC records generated yet.</td></tr>'}</tbody>
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
      `SELECT r.id, r.isbn, r.marc_json, r.marc_text, r.status, r.created_at, u.email AS user_email, u.autocat_user_id
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

    const ddc = extractDdcFromMarcJson(record.marc_json);

    res.send(
      layout({
        title: marcRecordDisplayId(record.id),
        activeHref: '/admin/records',
        body: `
          <p><a href="/admin/records">&larr; Back to records</a></p>
          <h2>${marcRecordDisplayId(record.id)} <span class="badge ${recordStatusBadgeClass(record.status)}">${escapeHtml(record.status)}</span></h2>
          <p class="muted">ISBN: ${escapeHtml(record.isbn ?? '—')} &middot; DDC: ${escapeHtml(ddc ?? '—')} &middot; User: ${escapeHtml(record.autocat_user_id ?? '—')} (${escapeHtml(record.user_email ?? 'deleted account')}) &middot; Created: ${new Date(record.created_at).toLocaleString()}</p>
          <h3>MARC data</h3>
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

function usageFiltersFromQuery(query) {
  const userId = Number(query.user_id);
  return {
    userId: Number.isInteger(userId) && userId > 0 ? userId : undefined,
    provider: ['nvidia', 'openai'].includes(query.provider) ? query.provider : undefined,
    status: ['success', 'failure'].includes(query.status) ? query.status : undefined,
    since: query.since ? new Date(query.since).toISOString() : undefined,
    until: query.until ? new Date(query.until).toISOString() : undefined,
  };
}

function usageRowsHtml(rows) {
  if (rows.length === 0) return '<tr><td colspan="8" class="muted">No matching requests yet.</td></tr>';
  return rows
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.email ?? 'unknown')}</td>
        <td>${escapeHtml(row.autocat_user_id ?? '—')}</td>
        <td><span class="badge">${escapeHtml(row.provider === 'openai' ? 'OpenAI' : 'NVIDIA')}</span></td>
        <td>${escapeHtml(row.model ?? '—')}</td>
        <td>${escapeHtml(row.request_type)}</td>
        <td>${row.tokens_used != null ? Number(row.tokens_used).toLocaleString() : '—'}</td>
        <td>${new Date(row.created_at).toLocaleString()}</td>
        <td><span class="badge ${row.status === 'success' ? 'badge-ok' : 'badge-off'}">${escapeHtml(row.status)}</span></td>
      </tr>`
    )
    .join('');
}

// GET /admin/usage/data -- JSON the Usage page polls (every 5s, see the
// inline script below) so the summary cards and live-activity table update
// on their own without the admin manually reloading. Plain polling rather
// than WebSocket/SSE: this admin dashboard is server-rendered, no-build-step
// HTML throughout (see admin.css/the rest of this file) -- polling a JSON
// endpoint fits that architecture without standing up a second transport.
router.get(
  '/usage/data',
  asyncHandler(async (req, res) => {
    const filters = usageFiltersFromQuery(req.query);
    const [summary, rows] = await Promise.all([usageSummary(filters), listUsage({ ...filters, limit: 100 })]);
    res.json({ summary, rowsHtml: usageRowsHtml(rows) });
  })
);

router.get(
  '/usage',
  asyncHandler(async (req, res) => {
    const filters = usageFiltersFromQuery(req.query);
    const [summary, rows, users] = await Promise.all([
      usageSummary(filters),
      listUsage({ ...filters, limit: 100 }),
      listUsageUsers(),
    ]);
    const queryString = new URLSearchParams(
      Object.fromEntries(Object.entries(req.query).filter(([, v]) => v))
    ).toString();

    res.send(
      layout({
        title: 'Usage',
        activeHref: '/admin/usage',
        body: `
          <h2>AI usage</h2>
          <p class="lede">Every logged AI request, per user and provider, updating automatically -- no manual refresh needed.</p>

          <div class="grid-4" id="usage-summary">
            <div class="panel stat-panel"><span class="stat-label">Total requests</span><span class="stat-value" id="stat-total">${summary.totalRequests}</span></div>
            <div class="panel stat-panel"><span class="stat-label">NVIDIA requests</span><span class="stat-value" id="stat-nvidia">${summary.nvidiaRequests}</span></div>
            <div class="panel stat-panel"><span class="stat-label">OpenAI requests</span><span class="stat-value" id="stat-openai">${summary.openaiRequests}</span></div>
            <div class="panel stat-panel"><span class="stat-label">Active users</span><span class="stat-value" id="stat-active">${summary.activeUsers}</span></div>
          </div>

          <div class="panel">
            <h3 class="panel-title">Filters</h3>
            <form class="inline" method="GET" action="/admin/usage" id="usage-filters">
              <select name="user_id">
                <option value="">All users</option>
                ${users.map((u) => `<option value="${u.id}" ${filters.userId === u.id ? 'selected' : ''}>${escapeHtml(u.autocat_user_id ?? '')} — ${escapeHtml(u.email)}</option>`).join('')}
              </select>
              <select name="provider">
                <option value="">All providers</option>
                <option value="nvidia" ${filters.provider === 'nvidia' ? 'selected' : ''}>NVIDIA</option>
                <option value="openai" ${filters.provider === 'openai' ? 'selected' : ''}>OpenAI</option>
              </select>
              <select name="status">
                <option value="">Any status</option>
                <option value="success" ${filters.status === 'success' ? 'selected' : ''}>Success</option>
                <option value="failure" ${filters.status === 'failure' ? 'selected' : ''}>Failure</option>
              </select>
              <input type="datetime-local" name="since" value="${escapeHtml(req.query.since || '')}" title="Since" />
              <input type="datetime-local" name="until" value="${escapeHtml(req.query.until || '')}" title="Until" />
              <button type="submit" class="btn btn-secondary">Apply</button>
              <a href="/admin/usage" class="btn btn-secondary">Clear</a>
            </form>
          </div>

          <div class="panel table-wrap">
            <h3 class="panel-title">Live activity</h3>
            <table>
              <thead><tr><th>User</th><th>ID</th><th>Provider</th><th>Model</th><th>Request</th><th>Tokens</th><th>Time</th><th>Status</th></tr></thead>
              <tbody id="usage-rows">${usageRowsHtml(rows)}</tbody>
            </table>
          </div>

          <script>
            (function () {
              const qs = ${JSON.stringify(queryString)};
              async function poll() {
                try {
                  const res = await fetch('/admin/usage/data' + (qs ? '?' + qs : ''), { credentials: 'same-origin' });
                  if (!res.ok) return;
                  const data = await res.json();
                  document.getElementById('stat-total').textContent = data.summary.totalRequests;
                  document.getElementById('stat-nvidia').textContent = data.summary.nvidiaRequests;
                  document.getElementById('stat-openai').textContent = data.summary.openaiRequests;
                  document.getElementById('stat-active').textContent = data.summary.activeUsers;
                  document.getElementById('usage-rows').innerHTML = data.rowsHtml;
                } catch {
                  // Transient network hiccup -- next poll tick will retry.
                }
              }
              setInterval(poll, 5000);
            })();
          </script>
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
