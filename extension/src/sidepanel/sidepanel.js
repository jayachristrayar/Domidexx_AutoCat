// AutoCat Side Panel -- the single primary UI (there is no popup). Talks
// to the backend only through src/services/api.js (which itself only
// talks to the background worker via chrome.runtime.sendMessage -- no
// fetch(), no API paths, no tokens ever appear in this file) and to the
// Koha content script only through src/services/koha.js. Every user-facing
// string here is a plain, human-readable status -- never a raw error,
// status code, or JSON payload.
import * as api from '../services/api.js';
import * as koha from '../services/koha.js';
import { debugLog } from '../services/config.js';

console.log('[AutoCat] Side panel initialized');

const app = document.getElementById('app');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stateHtml(kind, message) {
  const spinner = kind === 'loading' ? '<span class="spinner"></span>' : '';
  return `<div class="state ${kind}">${spinner}<span>${escapeHtml(message)}</span></div>`;
}

// ---------------------------------------------------------------------
// Boot: restore session if there is one, otherwise show the login screen.
// ---------------------------------------------------------------------

async function boot() {
  app.innerHTML = stateHtml('loading', 'Loading AutoCat…');
  try {
    const me = await api.getMe();
    renderWorkspace(me);
  } catch (error) {
    debugLog('boot getMe failed', error);
    renderAuth(error.code === 'NOT_LOGGED_IN' ? '' : error.message);
  }
}

// ---------------------------------------------------------------------
// Login / sign up
// ---------------------------------------------------------------------

function renderAuth(message = '') {
  app.innerHTML = `
    <div class="card auth-card">
      <div class="auth-logo">
        <img src="../../assets/logo/icon48.png" alt="AutoCat logo" />
        <h1>AutoCat</h1>
        <p>MARC cataloguing assistant</p>
      </div>
      ${message ? stateHtml('error', message) : ''}
      <div class="tabs">
        <button type="button" data-tab="login" class="active">Log in</button>
        <button type="button" data-tab="signup">Sign up</button>
      </div>
      <form id="auth-form" class="stack">
        <div id="auth-fields" class="stack"></div>
        <button type="submit" id="auth-submit" class="full">Log in</button>
      </form>
      <div id="auth-status"></div>
    </div>
  `;

  let mode = 'login';
  const fields = app.querySelector('#auth-fields');
  const submit = app.querySelector('#auth-submit');
  const statusEl = app.querySelector('#auth-status');

  function paintFields() {
    if (mode === 'login') {
      submit.textContent = 'Log in';
      fields.innerHTML = `
        <label><span>Email</span><input name="email" type="email" required autocomplete="username" /></label>
        <label><span>Password</span><input name="password" type="password" required minlength="1" autocomplete="current-password" /></label>
      `;
    } else {
      submit.textContent = 'Sign up';
      fields.innerHTML = `
        <label><span>Email</span><input name="email" type="email" required autocomplete="username" /></label>
        <label><span>Password</span><input name="password" type="password" required minlength="8" autocomplete="new-password" /></label>
        <label><span>Institution</span><input name="institution_slug" type="text" required placeholder="e.g. riverside-public-library" /></label>
      `;
    }
  }

  paintFields();

  app.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      mode = button.dataset.tab;
      app.querySelectorAll('[data-tab]').forEach((tab) => tab.classList.toggle('active', tab === button));
      statusEl.innerHTML = '';
      paintFields();
    });
  });

  app.querySelector('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    statusEl.innerHTML = stateHtml('loading', mode === 'login' ? 'Logging in…' : 'Creating your account…');
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');

    try {
      const me =
        mode === 'login'
          ? await api.login(email, password)
          : await api.signup(email, password, String(form.get('institution_slug') || '').trim());
      renderWorkspace(me);
    } catch (error) {
      submit.disabled = false;
      statusEl.innerHTML = stateHtml('error', error.message);
    }
  });
}

// ---------------------------------------------------------------------
// Main workspace
// ---------------------------------------------------------------------

function renderWorkspace(me) {
  app.innerHTML = `
    <div class="account-bar">
      <div class="who">
        <div class="email">${escapeHtml(me.email)}</div>
        <div class="tier">${escapeHtml(me.institution_name || 'No institution')} · ${escapeHtml(me.subscription_tier)} tier</div>
      </div>
      <button type="button" class="secondary" id="logout">Log out</button>
    </div>

    <div class="card">
      <p class="section-title">ISBN Lookup</p>
      <form id="lookup-form" class="row">
        <label><span>ISBN</span><input name="isbn" required placeholder="9780140328721" /></label>
        <button type="submit">Look up</button>
      </form>
      <div id="lookup-status"></div>
    </div>

    <div class="card">
      <p class="section-title">DDC Classification</p>
      <p class="hint">Analyze the whole-book subject before approving a classification number.</p>
      <form id="ddc-form" class="stack">
        <label><span>Title</span><input name="title" required /></label>
        <label><span>Description / TOC</span><textarea name="description" rows="4" placeholder="Paste description, abstract, or table of contents"></textarea></label>
        <button type="submit">Recommend DDC</button>
      </form>
      <div id="ddc-status"></div>
    </div>

    <div class="card">
      <p class="section-title">MARC Tools</p>
      <div class="stack">
        <button type="button" class="secondary" id="detect-fields">Detect MARC fields</button>
        <button type="button" class="secondary" id="generate-marc" disabled>Generate MARC</button>
        <button type="button" id="fill-koha" disabled>Fill MARC</button>
      </div>
      <div id="detect-status"></div>
      <div id="marc-status"></div>
      <div id="fill-status"></div>
    </div>

    <div class="card">
      <p class="section-title">Status</p>
      <div class="connection-status" id="connection-status">
        <span class="status-dot" id="status-dot"></span>
        <span id="status-text">Connected</span>
      </div>
    </div>
  `;

  const statusDot = app.querySelector('#status-dot');
  const statusText = app.querySelector('#status-text');
  function setConnected(ok) {
    statusDot.classList.toggle('off', !ok);
    statusText.textContent = ok ? 'Connected' : 'Connection issue';
  }

  app.querySelector('#logout').addEventListener('click', async () => {
    try {
      await api.logout();
    } catch (error) {
      debugLog('logout failed', error);
    }
    renderAuth();
  });

  // -- ISBN lookup --------------------------------------------------
  const lookupStatus = app.querySelector('#lookup-status');
  let currentMetadata = null;

  app.querySelector('#lookup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const isbn = String(new FormData(event.currentTarget).get('isbn') || '').trim();
    lookupStatus.innerHTML = stateHtml('loading', 'Looking up ISBN…');
    try {
      const body = await api.lookupIsbn(isbn);
      setConnected(true);
      if (body.not_found) {
        lookupStatus.innerHTML = stateHtml('error', 'ISBN not found.');
        return;
      }
      currentMetadata = body;
      app.querySelector('#ddc-form input[name="title"]').value = body.title || '';
      app.querySelector('#ddc-form textarea[name="description"]').value = body.description || '';
      lookupStatus.innerHTML = `
        ${stateHtml('success', 'ISBN metadata found')}
        <div class="result">
          <dl>
            <dt>Title</dt><dd>${escapeHtml(body.title || '(no title)')}</dd>
            <dt>Author</dt><dd>${escapeHtml((body.authors || []).join(', ') || 'Unknown')}</dd>
            <dt>Publisher</dt><dd>${escapeHtml(body.publisher || '—')}</dd>
            <dt>Published</dt><dd>${escapeHtml(body.publish_date || '—')}</dd>
          </dl>
        </div>
      `;
    } catch (error) {
      if (error.code === 'NETWORK_ERROR') setConnected(false);
      if (error.code === 'SESSION_EXPIRED') { renderAuth(error.message); return; }
      lookupStatus.innerHTML = stateHtml('error', error.message);
    }
  });

  // -- DDC classification --------------------------------------------
  const ddcStatus = app.querySelector('#ddc-status');
  let currentDdcDecision = null;
  const generateMarcButton = app.querySelector('#generate-marc');
  const fillKohaButton = app.querySelector('#fill-koha');
  let currentMarcResult = null;

  function updateFillAvailability() {
    const ddcApproved = currentDdcDecision?.decision?.approval_status === 'APPROVED';
    const marcValid = currentMarcResult?.validation?.valid === true;
    const hasPlan = Array.isArray(currentMarcResult?.koha_fill?.fields) && currentMarcResult.koha_fill.fields.length > 0;
    fillKohaButton.disabled = !(ddcApproved && marcValid && hasPlan);
  }

  app.querySelector('#ddc-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    ddcStatus.innerHTML = stateHtml('loading', 'Analyzing book subject…');
    try {
      const metadata = { ...(currentMetadata || {}), title: form.get('title'), description: form.get('description') };
      const body = await api.recommendDdc(metadata);
      setConnected(true);
      const d = body.decision;
      currentDdcDecision = { id: body.id, decision: d };
      ddcStatus.innerHTML = `
        ${stateHtml('success', 'DDC recommendation ready')}
        <div class="result">
          <dl>
            <dt>Subject</dt><dd>${escapeHtml(d.primary_subject)}</dd>
            <dt>Domain</dt><dd>${escapeHtml(d.disciplinary_domain)}</dd>
            <dt>Recommended</dt><dd>${escapeHtml(d.recommended_ddc?.number)} — ${escapeHtml(d.recommended_ddc?.label)}</dd>
            <dt>Confidence</dt><dd>${escapeHtml(d.recommended_ddc?.confidence)}</dd>
          </dl>
          <p class="result-heading">Why this number?</p>
          <p>${escapeHtml(d.justification)}</p>
          <p class="result-heading">Status</p>
          <p>Requires cataloguer approval</p>
          <button type="button" id="approve-ddc">Approve recommended DDC</button>
        </div>
      `;
      app.querySelector('#approve-ddc')?.addEventListener('click', async () => {
        const approveButton = app.querySelector('#approve-ddc');
        approveButton.disabled = true;
        try {
          const approved = await api.approveDdc(body.id);
          currentDdcDecision = { id: approved.id, decision: approved.decision };
          generateMarcButton.disabled = false;
          updateFillAvailability();
          ddcStatus.insertAdjacentHTML('beforeend', stateHtml('success', 'DDC approved. You can now generate MARC.'));
        } catch (error) {
          approveButton.disabled = false;
          if (error.code === 'SESSION_EXPIRED') { renderAuth(error.message); return; }
          ddcStatus.insertAdjacentHTML('beforeend', stateHtml('error', error.message));
        }
      });
    } catch (error) {
      if (error.code === 'NETWORK_ERROR') setConnected(false);
      if (error.code === 'SESSION_EXPIRED') { renderAuth(error.message); return; }
      ddcStatus.innerHTML = stateHtml('error', error.message);
    }
  });

  // -- MARC tools -------------------------------------------------------
  const detectStatus = app.querySelector('#detect-status');
  const marcStatus = app.querySelector('#marc-status');
  const fillStatus = app.querySelector('#fill-status');

  app.querySelector('#detect-fields').addEventListener('click', async () => {
    detectStatus.innerHTML = stateHtml('loading', 'Detecting MARC fields…');
    try {
      const tags = await koha.detectFields();
      if (tags.length === 0) {
        detectStatus.innerHTML = stateHtml('info', 'No MARC fields detected on this page.');
        return;
      }
      detectStatus.innerHTML = `
        ${stateHtml('success', `${tags.length} MARC field${tags.length === 1 ? '' : 's'} detected`)}
        <div class="result">${tags.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('')}</div>
      `;
    } catch (error) {
      detectStatus.innerHTML = stateHtml('error', error.message);
    }
  });

  generateMarcButton.addEventListener('click', async () => {
    if (!currentMetadata || !currentDdcDecision?.decision) return;
    marcStatus.innerHTML = stateHtml('loading', 'Generating MARC record…');
    currentMarcResult = null;
    updateFillAvailability();
    try {
      const body = await api.generateMarc(currentMetadata, currentDdcDecision.decision);
      setConnected(true);
      currentMarcResult = body;
      updateFillAvailability();
      const valid = body.validation?.valid === true;
      marcStatus.innerHTML = `
        ${stateHtml(valid ? 'success' : 'info', valid ? 'MARC record ready' : 'MARC record needs review')}
        <div class="result">
          <p class="result-heading">Fields</p>
          <div>${(body.preview || []).map((row) => `<span class="tag-chip">${escapeHtml(row.tag)}</span>`).join('')}</div>
          ${body.conflicts?.length ? `<p class="result-heading">Conflicts</p><p>${escapeHtml(body.conflicts.map((c) => c.field).join(', '))} — please double-check before filling Koha.</p>` : ''}
        </div>
      `;
    } catch (error) {
      if (error.code === 'NETWORK_ERROR') setConnected(false);
      if (error.code === 'SESSION_EXPIRED') { renderAuth(error.message); return; }
      marcStatus.innerHTML = stateHtml('error', error.message);
    }
  });

  fillKohaButton.addEventListener('click', async () => {
    if (fillKohaButton.disabled || !currentMarcResult?.koha_fill) return;
    fillStatus.innerHTML = stateHtml('loading', 'Filling MARC fields…');
    try {
      const ddcApproved = currentDdcDecision?.decision?.approval_status === 'APPROVED';
      const result = await koha.fillKoha(currentMarcResult.koha_fill, ddcApproved);
      const filled = result.filled?.length ?? 0;
      const conflicts = result.conflicts?.length ?? 0;
      const failed = result.failed?.length ?? 0;
      let summary = `${filled} field${filled === 1 ? '' : 's'} filled`;
      if (conflicts) summary += `, ${conflicts} conflict${conflicts === 1 ? '' : 's'} need${conflicts === 1 ? 's' : ''} review`;
      if (failed) summary += `, ${failed} failed`;
      fillStatus.innerHTML = `
        ${stateHtml(failed || conflicts ? 'info' : 'success', filled ? `MARC fields filled — ${summary}` : 'No new fields were filled')}
        <p class="hint">Nothing was saved — review the fields in Koha, then save manually.</p>
        ${conflicts ? `<div class="result"><p class="result-heading">Needs your review</p><ul>${result.conflicts.map((c) => `<li>${escapeHtml(c.tag)}${c.subfield ? `$${escapeHtml(c.subfield)}` : ''}: Koha already has “${escapeHtml(c.existing)}”, AutoCat suggests “${escapeHtml(c.proposed)}”</li>`).join('')}</ul></div>` : ''}
      `;
    } catch (error) {
      fillStatus.innerHTML = stateHtml('error', error.message);
    }
  });
}

boot();
