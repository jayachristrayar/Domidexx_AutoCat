import {
  apiFetch,
  readJson,
  getApiBaseUrl,
  setApiBaseUrl,
  setSessionToken,
  getSessionToken,
  getDeviceId,
  DEFAULT_API_BASE_URL,
} from '../lib/api.js';

console.log('[AutoCat] Extension initialized');

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
      const deviceId = await getDeviceId();
      const response = await apiFetch(mode === 'login' ? '/auth/login' : '/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ ...payload, device_id: deviceId }),
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
    <div class="panel">
      <h2>DDC Classification</h2>
      <p class="muted">Analyze the whole-book subject before approving 082$a.</p>
      <form id="ddc-form">
        <label><span>Title</span><input name="title" required /></label>
        <label><span>Description / TOC</span><textarea name="description" rows="4" placeholder="Paste description, abstract, or table of contents"></textarea></label>
        <button type="submit">Recommend DDC</button>
      </form>
      <div id="ddc-result"></div>
    </div>
    <div class="panel">
      <h2>MARC Preview</h2>
      <p class="muted">Generate a validated MARC record after DDC approval.</p>
      <button type="button" id="generate-marc" disabled>Generate MARC</button>
      <div id="marc-result"></div>
    </div>
    <div class="panel">
      <h2>Fill Koha</h2>
      <p class="muted">Fills the open Koha MARC editor tab from the validated record above. This never clicks Save — you always save manually after reviewing the fill.</p>
      <button type="button" id="fill-koha" disabled>Fill Koha</button>
      <div id="koha-fill-result"></div>
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
  const ddcResultEl = app.querySelector('#ddc-result');
  const marcResultEl = app.querySelector('#marc-result');
  const generateMarcButton = app.querySelector('#generate-marc');
  const fillKohaButton = app.querySelector('#fill-koha');
  const kohaFillResultEl = app.querySelector('#koha-fill-result');
  let currentMetadata = null;
  let currentDdcDecision = null;
  let currentMarcResult = null;

  function updateFillKohaAvailability() {
    const ddcApproved = currentDdcDecision?.decision?.approval_status === 'APPROVED';
    const marcValid = currentMarcResult?.validation?.valid === true;
    const hasPlan = Array.isArray(currentMarcResult?.koha_fill?.fields) && currentMarcResult.koha_fill.fields.length > 0;
    fillKohaButton.disabled = !(ddcApproved && marcValid && hasPlan);
  }
  app.querySelector('#ddc-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    ddcResultEl.innerHTML = '<p class="muted">Analyzing whole-book subject…</p>';
    try {
      const metadata = { ...(currentMetadata || {}), title: form.get('title'), description: form.get('description') };
      const response = await apiFetch('/api/ddc/recommend', { method: 'POST', body: JSON.stringify({ metadata }) });
      const body = await readJson(response);
      if (!response.ok) { ddcResultEl.innerHTML = `<div class="error">${escapeHtml(formatError(body, 'DDC recommendation failed.'))}</div>`; return; }
      const d = body.decision;
      currentDdcDecision = { id: body.id, decision: d };
      ddcResultEl.innerHTML = `<div class="result ddc-panel"><strong>Primary subject:</strong> ${escapeHtml(d.primary_subject)}<br /><strong>Disciplinary domain:</strong> ${escapeHtml(d.disciplinary_domain)}<br /><strong>Main class:</strong> ${escapeHtml(d.main_class?.number)} — ${escapeHtml(d.main_class?.label)}<br /><strong>Classification path:</strong> ${escapeHtml((d.classification_path || []).join(' → '))}<br /><strong>Recommended DDC:</strong> ${escapeHtml(d.recommended_ddc?.number)} — ${escapeHtml(d.recommended_ddc?.label)}<br /><strong>Confidence:</strong> ${escapeHtml(d.recommended_ddc?.confidence)}<br /><strong>Why this number?</strong><p>${escapeHtml(d.justification)}</p><strong>Evidence:</strong><ul>${(d.evidence || []).map((e) => `<li>✓ ${escapeHtml(e.type)}</li>`).join('')}</ul><strong>Alternative candidates:</strong><ul>${(d.alternatives || []).map((a) => `<li>${escapeHtml(a.number)} — ${escapeHtml(a.label)}: ${escapeHtml(a.reason_rejected)}</li>`).join('') || '<li>None</li>'}</ul><strong>Provenance:</strong> ${escapeHtml((d.provenance || []).join(', '))}<br /><strong>Status:</strong> REQUIRES CATALOGUER APPROVAL<br /><button type="button" id="approve-ddc">Approve recommended DDC</button></div>`;
      app.querySelector('#approve-ddc')?.addEventListener('click', async () => {
        const approval = await apiFetch(`/api/ddc/${body.id}/approve`, { method: 'POST', body: JSON.stringify({ action: 'APPROVE' }) });
        const approvedBody = await readJson(approval);
        if (!approval.ok) { ddcResultEl.insertAdjacentHTML('beforeend', `<div class="error">${escapeHtml(formatError(approvedBody, 'DDC approval failed.'))}</div>`); return; }
        currentDdcDecision = { id: approvedBody.id, decision: approvedBody.decision };
        generateMarcButton.disabled = false;
        updateFillKohaAvailability();
        ddcResultEl.insertAdjacentHTML('beforeend', '<div class="success">DDC approved. MARC generation is now available.</div>');
      });
    } catch (error) { ddcResultEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`; }
  });

  generateMarcButton.addEventListener('click', async () => {
    if (!currentMetadata || !currentDdcDecision?.decision) return;
    marcResultEl.innerHTML = '<p class="muted">Generating MARC preview…</p>';
    currentMarcResult = null;
    updateFillKohaAvailability();
    try {
      const response = await apiFetch('/records/generate-marc', { method: 'POST', body: JSON.stringify({ metadata: currentMetadata, ddc_approval: currentDdcDecision.decision }) });
      const body = await readJson(response);
      if (!response.ok) {
        marcResultEl.innerHTML = `<div class="error">${escapeHtml(formatError(body, 'MARC generation requires review.'))}</div>`;
        return;
      }
      currentMarcResult = body;
      updateFillKohaAvailability();
      marcResultEl.innerHTML = `<div class="result marc-preview"><strong>Status:</strong> ${escapeHtml(body.status)}<br /><strong>Validation:</strong> ${body.validation?.valid ? 'VALID' : 'REQUIRES REVIEW'}<table><thead><tr><th>Tag</th><th>Ind</th><th>Value</th><th>Source</th><th>Status</th></tr></thead><tbody>${(body.preview || []).map((row) => `<tr><td>${escapeHtml(row.tag)}</td><td>${escapeHtml(row.indicators)}</td><td>${escapeHtml(row.value)}</td><td>${escapeHtml(row.source)}</td><td>${escapeHtml(row.validation_status)}</td></tr>`).join('')}</tbody></table>${body.conflicts?.length ? `<div class="error">Metadata conflicts: ${escapeHtml(body.conflicts.map((c) => c.field).join(', '))}</div>` : ''}</div>`;
    } catch (error) {
      marcResultEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  });

  fillKohaButton.addEventListener('click', async () => {
    if (fillKohaButton.disabled || !currentMarcResult?.koha_fill) return;
    kohaFillResultEl.innerHTML = '<p class="muted">Filling the open Koha MARC editor tab…</p>';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        console.error('[AutoCat] Fill Koha failed: no active browser tab found.');
        kohaFillResultEl.innerHTML = '<div class="error">No active browser tab found.</div>';
        return;
      }
      const ddcApproved = currentDdcDecision?.decision?.approval_status === 'APPROVED';
      const result = await chrome.tabs.sendMessage(tab.id, {
        type: 'AUTOCAT_KOHA_FILL',
        plan: currentMarcResult.koha_fill,
        ddcApproved,
      });
      if (!result) {
        console.error('[AutoCat] Unsupported Koha page: no response from the content script.');
        kohaFillResultEl.innerHTML = '<div class="error">No response from the Koha tab. Open the Koha MARC editor (cataloguing/addbiblio.pl) and try again.</div>';
        return;
      }
      renderKohaFillResult(result);
    } catch (error) {
      // chrome.tabs.sendMessage rejects with "Receiving end does not exist"
      // when the active tab isn't a Koha cataloguing page the content
      // script runs on -- this is the expected/common failure mode, not a
      // bug, so it gets a specific message rather than a raw stack trace.
      console.error('[AutoCat] Unsupported Koha page:', error.message);
      kohaFillResultEl.innerHTML = `<div class="error">Could not reach the Koha tab (${escapeHtml(error.message)}). Open the Koha MARC editor (cataloguing/addbiblio.pl) in this tab and try again.</div>`;
    }
  });

  function renderKohaFillResult(result) {
    if (result.status === 'failed' && result.error) {
      kohaFillResultEl.innerHTML = `<div class="error">${escapeHtml(result.error)}</div>`;
      return;
    }
    const section = (label, items, render) =>
      items?.length
        ? `<strong>${escapeHtml(label)} (${items.length})</strong><ul>${items.map(render).join('')}</ul>`
        : '';
    const tagSf = (item) => `${escapeHtml(item.tag)}${item.subfield ? `$${escapeHtml(item.subfield)}` : ''}`;
    kohaFillResultEl.innerHTML = `
      <div class="result koha-fill-result">
        <strong>Status:</strong> ${escapeHtml(result.status)}<br />
        <p class="muted">Fill only — nothing was saved. Review below, then save manually in Koha.</p>
        ${section('Filled', result.filled, (i) => `<li>${tagSf(i)}</li>`)}
        ${section('Already present', result.already_present, (i) => `<li>${tagSf(i)}: ${escapeHtml(i.existing)}</li>`)}
        ${section('Conflicts — resolve manually', result.conflicts, (i) => `<li>${tagSf(i)}<br />Existing: ${escapeHtml(i.existing)}<br />Proposed: ${escapeHtml(i.proposed)}</li>`)}
        ${section('Failed verification', result.failed, (i) => `<li>${tagSf(i)}: ${escapeHtml(i.reason)}</li>`)}
        ${section('Skipped', result.skipped, (i) => `<li>${tagSf(i)}: ${escapeHtml(i.reason)}</li>`)}
      </div>
    `;
  }

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
      currentMetadata = body;
      app.querySelector('#ddc-form input[name="title"]').value = body.title || '';
      app.querySelector('#ddc-form textarea[name="description"]').value = body.description || '';
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
