import {
  apiFetch,
  readJson,
  getApiBaseUrl,
  setApiBaseUrl,
  setSessionToken,
  getSessionToken,
  DEFAULT_API_BASE_URL,
} from '../lib/api.js';

const app = document.getElementById('app');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatError(payload, fallback) {
  if (!payload) return fallback;
  if (typeof payload.error === 'string') return payload.error;
  if (payload.error?.fieldErrors) {
    const fields = Object.entries(payload.error.fieldErrors)
      .flatMap(([field, messages]) => (messages || []).map((message) => `${field}: ${message}`));
    if (fields.length) return fields.join('; ');
  }
  return fallback;
}

async function render() {
  app.innerHTML = '<p class="muted">Loading…</p>';

  const token = await getSessionToken();
  if (!token) {
    renderAuth();
    return;
  }

  try {
    const response = await apiFetch('/me');
    const body = await readJson(response);
    if (!response.ok) {
      await setSessionToken(null);
      renderAuth(formatError(body, 'Session expired. Please log in again.'));
      return;
    }
    renderWorkspace(body);
  } catch (error) {
    renderAuth(`Could not reach the AutoCat API: ${error.message}`);
  }
}

function renderAuth(errorMessage = '') {
  app.innerHTML = `
    <div class="tabs">
      <button type="button" data-tab="login" class="active">Log in</button>
      <button type="button" data-tab="signup">Sign up</button>
    </div>
    ${errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : ''}
    <form id="auth-form">
      <div id="auth-fields"></div>
      <div class="row">
        <button type="submit" id="auth-submit">Log in</button>
      </div>
    </form>
    <div class="panel">
      <label>
        <span>API base URL</span>
        <input id="api-base" type="url" />
      </label>
      <button type="button" class="secondary" id="save-api">Save API URL</button>
      <p class="muted" style="margin-top:8px">Default: ${escapeHtml(DEFAULT_API_BASE_URL)}</p>
    </div>
  `;

  let mode = 'login';
  const fields = app.querySelector('#auth-fields');
  const submit = app.querySelector('#auth-submit');
  const apiBaseInput = app.querySelector('#api-base');

  getApiBaseUrl().then((url) => {
    apiBaseInput.value = url;
  });

  function paintFields() {
    if (mode === 'login') {
      submit.textContent = 'Log in';
      fields.innerHTML = `
        <label><span>Email</span><input name="email" type="email" required autocomplete="username" /></label>
        <label><span>Password</span><input name="password" type="password" required minlength="1" autocomplete="current-password" /></label>
      `;
    } else {
      submit.textContent = 'Create account';
      fields.innerHTML = `
        <label><span>Email</span><input name="email" type="email" required autocomplete="username" /></label>
        <label><span>Password</span><input name="password" type="password" required minlength="8" autocomplete="new-password" /></label>
        <label><span>Institution slug</span><input name="institution_slug" type="text" required placeholder="e.g. riverside-public-library" /></label>
      `;
    }
  }

  paintFields();

  app.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      mode = button.dataset.tab;
      app.querySelectorAll('[data-tab]').forEach((tab) => {
        tab.classList.toggle('active', tab === button);
      });
      paintFields();
    });
  });

  app.querySelector('#save-api').addEventListener('click', async () => {
    await setApiBaseUrl(apiBaseInput.value);
    apiBaseInput.value = await getApiBaseUrl();
    const notice = document.createElement('div');
    notice.className = 'success';
    notice.textContent = 'API URL saved.';
    app.querySelector('.panel').prepend(notice);
  });

  app.querySelector('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    const form = new FormData(event.currentTarget);
    const payload = {
      email: String(form.get('email') || '').trim(),
      password: String(form.get('password') || ''),
    };
    if (mode === 'signup') {
      payload.institution_slug = String(form.get('institution_slug') || '').trim();
    }

    try {
      const response = await apiFetch(mode === 'login' ? '/auth/login' : '/auth/signup', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const body = await readJson(response);
      if (!response.ok || !body?.token) {
        renderAuth(formatError(body, mode === 'login' ? 'Login failed.' : 'Signup failed.'));
        return;
      }
      await setSessionToken(body.token);
      await render();
    } catch (error) {
      renderAuth(`Could not reach the AutoCat API: ${error.message}`);
    }
  });
}

function renderWorkspace(me) {
  app.innerHTML = `
    <div class="meta">
      <strong>${escapeHtml(me.email)}</strong><br />
      ${escapeHtml(me.institution_name || 'No institution')} · ${escapeHtml(me.subscription_tier)} tier
    </div>
    <div class="panel">
      <h2>ISBN lookup</h2>
      <form id="lookup-form" class="row">
        <label style="flex:1;margin:0">
          <span>ISBN</span>
          <input name="isbn" required placeholder="9780140328721" />
        </label>
        <div style="align-self:end">
          <button type="submit">Look up</button>
        </div>
      </form>
      <div id="lookup-result"></div>
    </div>
    <div class="panel row">
      <button type="button" class="secondary" id="logout">Log out</button>
    </div>
  `;

  app.querySelector('#logout').addEventListener('click', async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } catch {
      // Clear local session even if the network call fails.
    }
    await setSessionToken(null);
    renderAuth();
  });

  const resultEl = app.querySelector('#lookup-result');
  app.querySelector('#lookup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const isbn = String(new FormData(event.currentTarget).get('isbn') || '').trim();
    resultEl.innerHTML = '<p class="muted">Looking up…</p>';
    try {
      const response = await apiFetch(`/records/lookup/${encodeURIComponent(isbn)}`);
      const body = await readJson(response);
      if (!response.ok) {
        resultEl.innerHTML = `<div class="error">${escapeHtml(formatError(body, 'Lookup failed.'))}</div>`;
        return;
      }
      if (body.not_found) {
        resultEl.innerHTML = `<div class="error">No catalog match for ${escapeHtml(body.isbn || isbn)}.</div>`;
        return;
      }
      resultEl.innerHTML = `
        <div class="result">
          <strong>${escapeHtml(body.title || '(no title)')}</strong><br />
          ${escapeHtml((body.authors || []).join(', ') || 'Unknown author')}<br />
          <span class="muted">${escapeHtml(body.publisher || '')} ${escapeHtml(body.publish_date || '')}</span><br />
          <span class="muted">Provenance: ${escapeHtml(body.provenance || 'unknown')}</span>
        </div>
      `;
    } catch (error) {
      resultEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  });
}

render();
