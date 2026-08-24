// AutoCat Side Panel -- the single primary UI (there is no popup). Talks
// to the backend only through src/services/api.js (which itself only
// talks to the background worker via chrome.runtime.sendMessage -- no
// fetch(), no API paths, no tokens ever appear in this file) and to the
// Koha content script only through src/services/koha.js. Every user-facing
// string here is a plain, human-readable status -- never a raw error,
// status code, or JSON payload.
//
// One screen, one workflow: entering an ISBN and pressing "Look up" chains
// lookup -> whole-book DDC analysis -> DDC approval -> MARC generation
// automatically (product spec section 33) -- there is no "Generate DDC" /
// "Approve" / "Generate MARC" sequence of separate buttons. The chat panel
// at the bottom is for exceptions/corrections only (section 34): wrong
// book, wrong metadata, DDC disagreement, "why this number", etc.
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
// ISBN normalization/shape check -- client-side only, for deciding when to
// auto-trigger a lookup (a barcode scanner is just a very fast keyboard, so
// this is the same input a librarian could type by hand). The backend
// remains the sole source of truth for real ISBN validation.
// ---------------------------------------------------------------------

function normalizeIsbnValue(value) {
  return String(value ?? '').replace(/[-\s]/g, '').toUpperCase();
}

function looksLikeIsbn(value) {
  return /^(?:\d{9}[\dX]|\d{13})$/.test(value);
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

const ACTIVATION_CONTACT_EMAIL = 'team.domidexx@gmail.com';

function contactActivationHtml(label = 'Need access? Contact us for activation') {
  return `<p class="contact-activation">${escapeHtml(label)}: <a href="mailto:${ACTIVATION_CONTACT_EMAIL}">${ACTIVATION_CONTACT_EMAIL}</a></p>`;
}

// Shown after a successful signup (product spec section 2/10): the account
// was created but is PENDING, and signup never issues a session -- there
// is no workspace to move into, so this replaces the form rather than
// logging the librarian in.
function renderPendingActivation(data) {
  app.innerHTML = `
    <div class="card auth-card">
      <div class="auth-logo">
        <img src="../../assets/logo/icon48.png" alt="AutoCat logo" />
        <h1>AutoCat</h1>
        <p>MARC cataloguing assistant</p>
      </div>
      ${stateHtml('success', 'Account created successfully.')}
      <p>${escapeHtml(data.message || 'Your account is currently pending activation by an administrator. Please contact the AutoCat team to request credential activation.')}</p>
      <a class="button full" href="mailto:${ACTIVATION_CONTACT_EMAIL}">Contact us for activation</a>
      <button type="button" class="secondary full" id="back-to-login">Back to log in</button>
    </div>
  `;
  app.querySelector('#back-to-login').addEventListener('click', () => renderAuth());
}

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
      ${contactActivationHtml()}
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
      if (mode === 'login') {
        const me = await api.login(email, password);
        renderWorkspace(me);
        return;
      }
      // Signup never logs the librarian in -- the account is created
      // PENDING and stays that way until an administrator approves it.
      const pending = await api.signup(email, password, String(form.get('institution_slug') || '').trim());
      renderPendingActivation(pending);
    } catch (error) {
      submit.disabled = false;
      statusEl.innerHTML = stateHtml('error', error.message);
    }
  });
}

// ---------------------------------------------------------------------
// Koha connection status pill
// ---------------------------------------------------------------------

const KOHA_STATUS_META = {
  NOT_DETECTED: { dot: 'red', label: 'KOHA NOT DETECTED', detail: 'Open a Koha cataloguing page to use AutoCat.' },
  DETECTING: { dot: 'yellow', label: 'DETECTING KOHA…', detail: '' },
  DETECTED_NO_EDITOR: { dot: 'yellow', label: 'KOHA DETECTED', detail: 'MARC editor not available on this page.' },
  CONNECTED: { dot: 'green', label: 'KOHA CONNECTED', detail: 'Add MARC record' },
};

function kohaStatusHtml(state) {
  const meta = KOHA_STATUS_META[state] || KOHA_STATUS_META.NOT_DETECTED;
  return `
    <span class="koha-dot ${meta.dot}"></span>
    <span class="koha-label">${escapeHtml(meta.label)}</span>
    ${meta.detail ? `<span class="koha-detail">${escapeHtml(meta.detail)}</span>` : ''}
  `;
}

// ---------------------------------------------------------------------
// AI model selector. The librarian must never learn which underlying
// provider they're using -- only the backend's generic MODEL_1/MODEL_2
// labels ever reach this file (see backend/src/services/modelLabels.js;
// /me and /api/ddc/recommend both translate before responding). No
// "NVIDIA"/"OpenAI"/tier/plan/API wording is ever rendered here -- the
// Admin Panel is the only place that shows real provider configuration.
// ---------------------------------------------------------------------

// MODEL_OWN is additive (product spec: a third option alongside, never
// replacing, Model 1/Model 2) -- its availability is never governed by
// modelAccess/the admin FREE/PAID grant those two use, only by whether the
// librarian has connected their own API (see ownModelSettingsHtml below),
// so it never carries the "locked" treatment MODEL_1/MODEL_2 do.
const ALL_MODELS = ['MODEL_1', 'MODEL_2', 'MODEL_OWN'];
const MODEL_DISPLAY_NAMES = { MODEL_1: 'Model 1', MODEL_2: 'Model 2', MODEL_OWN: 'Your Own Model' };

// Three buttons, always all shown -- the active one carries a checkmark, an
// unauthorized Model 1/2 carries a lock icon (still clickable: clicking it
// shows the "not available" message rather than silently doing nothing).
function modelButtonsHtml(modelAccess, selected) {
  const access = Array.isArray(modelAccess) && modelAccess.length > 0 ? modelAccess : ['MODEL_1'];
  return `
    <div class="model-buttons" id="model-buttons">
      ${ALL_MODELS.map((model) => {
        const isOwn = model === 'MODEL_OWN';
        const available = isOwn || access.includes(model);
        const active = model === selected;
        const classes = ['model-btn'];
        if (active) classes.push('active');
        if (!available) classes.push('locked');
        return `<button type="button" class="${classes.join(' ')}" data-model="${model}">${escapeHtml(MODEL_DISPLAY_NAMES[model])}${active ? ' <span class="model-check">✓</span>' : ''}${!available ? ' <span class="model-lock">🔒</span>' : ''}</button>`;
      }).join('')}
    </div>
  `;
}

// ---------------------------------------------------------------------
// "Your Own Model" settings -- shown only while MODEL_OWN is selected
// (product spec: keep the model selector simple, no large settings
// screen). Only ever asks for API Base URL + API Key, per spec section
// "YOUR OWN MODEL" -- never a provider/model/tier field.
// ---------------------------------------------------------------------

function ownModelSettingsHtml(status) {
  const connected = Boolean(status?.configured);
  return `
    <p class="section-title">Your Own Model</p>
    ${connected ? '<p class="muted">✓ Own API connected</p>' : '<p class="hint">Connect any OpenAI-compatible API -- self-hosted or third-party.</p>'}
    <label><span>API Base URL</span><input type="text" id="own-api-base-url" placeholder="https://api.example.com/v1" value="${escapeHtml(status?.base_url || '')}" autocomplete="off" /></label>
    <label><span>API Key</span><input type="password" id="own-api-key" placeholder="${connected ? escapeHtml(status.api_key_masked) : 'sk-...'}" autocomplete="off" /></label>
    ${connected ? '<p class="hint">Re-enter both fields to update your connection.</p>' : ''}
    <div class="row">
      <button type="button" id="own-api-test" class="secondary">Test Connection</button>
      <button type="button" id="own-api-save" disabled>Save</button>
    </div>
    <div id="own-api-status"></div>
  `;
}

// ---------------------------------------------------------------------
// Book details
// ---------------------------------------------------------------------

function bookDetailsHtml(metadata) {
  const authors = (metadata.authors || []).join(', ') || 'Unknown';
  const rows = [
    ['Title', metadata.title],
    ['Subtitle', metadata.subtitle],
    ['Author', authors],
    ['Editors', (metadata.editors || []).join(', ')],
    ['Illustrators', (metadata.illustrators || []).join(', ')],
    ['Translators', (metadata.translators || []).join(', ')],
    ['Edition', metadata.edition],
    ['Publisher', metadata.publisher],
    ['Published', metadata.publish_date],
    ['ISBN', metadata.isbn],
    ['Language', metadata.language],
    ['Pages', metadata.physical_description?.pages],
    ['Series', metadata.series?.name ?? metadata.series],
    ['Subjects', (metadata.subjects || []).join(', ')],
    ['Existing classification', (metadata.existing_classifications || []).map((c) => c.number).join(', ')],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');

  const primary = rows.slice(0, 4);
  const rest = rows.slice(4);

  return `
    ${stateHtml('success', 'Book found')}
    <div class="result">
      <dl>
        ${primary.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}
      </dl>
      ${rest.length ? `
        <details class="book-more">
          <summary>More details</summary>
          <dl>${rest.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>
          ${metadata.description ? `<p class="result-heading">Description</p><p>${escapeHtml(metadata.description)}</p>` : ''}
          ${metadata.table_of_contents ? `<p class="result-heading">Table of contents</p><p>${escapeHtml(metadata.table_of_contents)}</p>` : ''}
        </details>
      ` : ''}
      ${metadata.provenance === 'unverified' ? '<p class="hint">Sourced via AI-assisted web research -- please verify against the physical item.</p>' : ''}
    </div>
  `;
}

// ---------------------------------------------------------------------
// DDC 23 classification
// ---------------------------------------------------------------------

function confidenceBadgeClass(confidence) {
  const c = String(confidence || '').toUpperCase();
  if (c === 'HIGH') return 'confidence-high';
  if (c === 'MEDIUM') return 'confidence-medium';
  return 'confidence-low';
}

function ddcHtml(decision, source) {
  if (!decision?.recommended_ddc) {
    return stateHtml('info', 'Insufficient evidence to determine a reliable DDC 23 classification. Add a description or table of contents and try again.');
  }
  const rec = decision.recommended_ddc;
  const breakdown = decision.number_breakdown?.length
    ? decision.number_breakdown
    : (decision.classification_path || []).map((n) => ({ number: n, label: '' }));

  return `
    <div class="ddc-number">
      <span class="ddc-value">${escapeHtml(rec.number)}</span>
      <span class="badge ${confidenceBadgeClass(rec.confidence)}">${escapeHtml(rec.confidence || 'UNKNOWN')}</span>
    </div>
    <p class="ddc-label">${escapeHtml(rec.label || decision.primary_subject || '')}</p>
    <p class="source-tag">${source === 'cataloguer' ? 'Cataloguer-approved classification' : 'AutoCat AI recommendation'}</p>

    <p class="result-heading">Why this number?</p>
    <p>${escapeHtml(decision.justification || '')}</p>

    ${breakdown.length ? `
      <p class="result-heading">Number breakdown</p>
      <div class="breakdown">
        ${breakdown.map((p, i) => `${i > 0 ? '<span class="breakdown-arrow">↓</span>' : ''}<div class="breakdown-row"><span class="breakdown-num">${escapeHtml(p.number)}</span><span class="breakdown-label">${escapeHtml(p.label || '')}</span></div>`).join('')}
      </div>
    ` : ''}

    ${decision.alternatives_considered?.length ? `
      <p class="result-heading">Alternative numbers considered</p>
      <ul>${decision.alternatives_considered.slice(0, 3).map((a) => `<li><strong>${escapeHtml(a.number)}</strong>${a.class_name ? ` — ${escapeHtml(a.class_name)}` : ''}: ${escapeHtml(a.why_not_selected || '')}</li>`).join('')}</ul>
    ` : decision.alternatives?.length ? `
      <p class="result-heading">Alternative considered</p>
      <ul>${decision.alternatives.slice(0, 2).map((a) => `<li><strong>${escapeHtml(a.number)}</strong> — ${escapeHtml(a.label)}: ${escapeHtml(a.reason_rejected || a.reason_considered || '')}</li>`).join('')}</ul>
    ` : ''}

    ${(decision.evidence?.length || decision.sources?.length) ? `
      <details class="ddc-evidence">
        <summary>Show evidence</summary>
        ${decision.sources?.length ? `<p class="result-heading">Sources</p><ul>${decision.sources.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>` : ''}
        ${decision.evidence?.length ? `<p class="result-heading">Evidence used</p><ul>${decision.evidence.map((e) => `<li>${escapeHtml(typeof e === 'string' ? e : e.value)}</li>`).join('')}</ul>` : ''}
      </details>
    ` : ''}
  `;
}

// ---------------------------------------------------------------------
// MARC preview
// ---------------------------------------------------------------------

function marcHtml(marcResult) {
  const valid = marcResult.validation?.valid === true;
  const rows = marcResult.preview || [];
  return `
    ${stateHtml(valid ? 'success' : 'info', valid ? 'MARC READY' : 'MARC needs review before it can be filled')}
    <div class="result">
      <details class="marc-preview" ${rows.length <= 12 ? 'open' : ''}>
        <summary>${rows.length} field${rows.length === 1 ? '' : 's'} prepared</summary>
        <div class="marc-lines">
          ${rows.map((row) => `<div class="marc-line"><span class="tag-chip">${escapeHtml(row.tag)}</span><span class="marc-value">${escapeHtml(row.value)}</span></div>`).join('')}
        </div>
      </details>
      ${marcResult.conflicts?.length ? `<p class="result-heading">Source conflicts</p><p class="hint">${escapeHtml(marcResult.conflicts.map((c) => c.field).join(', '))} differ between sources -- the most reliable value was used.</p>` : ''}
      ${!valid ? `<p class="result-heading">Needs attention</p><ul>${(marcResult.validation?.errors || []).map((e) => `<li>${escapeHtml(e.message)}</li>`).join('')}</ul>` : ''}
    </div>
  `;
}

// ---------------------------------------------------------------------
// Main workspace
// ---------------------------------------------------------------------

function renderWorkspace(me) {
  app.innerHTML = `
    <div class="account-bar">
      <div class="who">
        <div class="section-title">Account</div>
        <div class="email">${escapeHtml(me.email)}</div>
        ${me.autocat_user_id ? `<div class="doac-id">${escapeHtml(me.autocat_user_id)}</div>` : ''}
      </div>
      <button type="button" class="secondary" id="logout">Log out</button>
    </div>

    <div class="card koha-status-card" id="koha-status">${kohaStatusHtml('DETECTING')}</div>

    <div class="card" id="model-card">
      <p class="section-title">AI Model</p>
      <div id="model-buttons-wrap">${modelButtonsHtml(me.model_access, (me.model_access && me.model_access[0]) || 'MODEL_1')}</div>
      <div id="own-model-settings" hidden></div>
      <div id="model-status"></div>
    </div>

    <div class="card">
      <label class="section-title" for="isbn-input">ISBN</label>
      <form id="lookup-form" class="row">
        <input id="isbn-input" name="isbn" required placeholder="9780140328721" autocomplete="off" />
        <button type="submit" id="lookup-submit">Look up</button>
        <button type="button" id="cancel-lookup" class="secondary" hidden>Cancel lookup</button>
        <button type="button" id="new-lookup" class="secondary" hidden>New lookup</button>
      </form>
      <div id="lookup-status"></div>
    </div>

    <div class="card" id="book-card" hidden>
      <p class="section-title">Book</p>
      <div id="book-status"></div>
    </div>

    <div class="card" id="ddc-card" hidden>
      <p class="section-title">DDC 23 Classification</p>
      <div id="ddc-status"></div>
    </div>

    <div class="card" id="marc-card" hidden>
      <p class="section-title">MARC</p>
      <div id="marc-status"></div>
      <button type="button" id="fill-koha" class="full" disabled>Fill MARC</button>
      <div id="fill-status"></div>
    </div>

    <div class="card">
      <p class="section-title">Ask AutoCat</p>
      <p class="hint">Use this to correct something -- wrong book, wrong author, a different DDC number, or to ask why a number was chosen.</p>
      <div id="chat-log" class="chat-log"></div>
      <form id="chat-form" class="row">
        <label class="chat-input-label"><span class="sr-only">Message</span><input name="message" placeholder="Ask something…" autocomplete="off" /></label>
        <button type="submit" id="chat-send">Send</button>
        <button type="button" id="chat-clear" class="secondary">Clear</button>
      </form>
      <div id="chat-status"></div>
    </div>
  `;

  app.querySelector('#logout').addEventListener('click', async () => {
    try {
      await api.logout();
    } catch (error) {
      debugLog('logout failed', error);
    }
    stopKohaStatusWatch();
    renderAuth();
  });

  // -- Koha connection status (auto, top of panel) -----------------------
  const kohaStatusEl = app.querySelector('#koha-status');
  async function refreshKohaStatus() {
    const status = await koha.getStatus();
    kohaStatusEl.innerHTML = kohaStatusHtml(status.state);
  }
  refreshKohaStatus();
  const unsubscribeTabChange = koha.onTabChange(refreshKohaStatus);
  const kohaStatusInterval = setInterval(refreshKohaStatus, 5000);
  function stopKohaStatusWatch() {
    unsubscribeTabChange();
    clearInterval(kohaStatusInterval);
  }

  // -- Shared workspace state --------------------------------------------
  const state = {
    // Bumped at the start of every new ISBN lookup, and by Cancel lookup.
    // Any in-flight async step (ISBN fetch, DDC recommend, MARC generate)
    // checks this against the id it captured when it started -- if they no
    // longer match, its result is stale (superseded by a newer lookup, or
    // cancelled) and must never touch state/UI (product spec item 13:
    // "lookup A finishing after lookup B must never overwrite B's result").
    lookupId: 0,
    isbn: null,
    metadata: null,
    ddcId: null,
    ddcDecision: null,
    ddcSource: 'ai', // 'ai' | 'cataloguer' -- section 41: keep these distinguishable
    marcResult: null,
    // Set when Ask AutoCat just asked a follow-up question ("What is the
    // correct author name?") -- so the librarian's next plain-text reply
    // ("Emily Bronte") is understood as the answer to that question rather
    // than falling through to the generic "I didn't understand" response.
    // Cleared by Clear and once a reply consumes it (see chatService.js).
    chatPendingField: null,
    // modelAccess holds only the generic MODEL_1/MODEL_2 labels the backend
    // sent -- never a real provider name. Defaults to whatever the account
    // is granted (MODEL_1 for every account unless an admin also granted
    // MODEL_2). Only ever changed by the librarian clicking a model button
    // below, never inferred or silently swapped by the extension itself.
    modelAccess: Array.isArray(me.model_access) && me.model_access.length > 0 ? me.model_access : ['MODEL_1'],
    selectedModel: (me.model_access && me.model_access[0]) || 'MODEL_1',
    // Comes straight from /me's own_api field (never a plaintext key --
    // see backend/src/services/ownApiService.getOwnApiStatus) so the panel
    // knows on load whether Your Own Model is already connected, without a
    // second round trip.
    ownApiStatus: me.own_api || { configured: false },
  };

  const modelStatus = app.querySelector('#model-status');
  const modelButtonsWrap = app.querySelector('#model-buttons-wrap');
  const ownModelSettingsEl = app.querySelector('#own-model-settings');

  function renderModelButtons() {
    modelButtonsWrap.innerHTML = modelButtonsHtml(state.modelAccess, state.selectedModel);
  }

  // Test Connection must succeed in THIS edit session before Save is
  // enabled (product spec: "After successful testing, allow: [Save]") --
  // tracked here rather than trusting a previously-saved `configured: true`
  // status, since the fields may have just been edited to something
  // untested.
  let ownApiTestPassed = false;

  function renderOwnModelSettings() {
    const isOwn = state.selectedModel === 'MODEL_OWN';
    ownModelSettingsEl.hidden = !isOwn;
    if (!isOwn) return;
    ownApiTestPassed = false;
    ownModelSettingsEl.innerHTML = ownModelSettingsHtml(state.ownApiStatus);

    const baseUrlInput = ownModelSettingsEl.querySelector('#own-api-base-url');
    const apiKeyInput = ownModelSettingsEl.querySelector('#own-api-key');
    const testButton = ownModelSettingsEl.querySelector('#own-api-test');
    const saveButton = ownModelSettingsEl.querySelector('#own-api-save');
    const ownApiStatusEl = ownModelSettingsEl.querySelector('#own-api-status');

    // Any edit after a successful test invalidates it -- Save must not stay
    // enabled for fields the librarian has since changed.
    [baseUrlInput, apiKeyInput].forEach((input) =>
      input.addEventListener('input', () => {
        ownApiTestPassed = false;
        saveButton.disabled = true;
      })
    );

    testButton.addEventListener('click', async () => {
      const baseUrl = baseUrlInput.value.trim();
      const apiKey = apiKeyInput.value.trim();
      if (!baseUrl || !apiKey) {
        ownApiStatusEl.innerHTML = stateHtml('error', 'API Base URL and API Key are both required.');
        return;
      }
      testButton.disabled = true;
      ownApiStatusEl.innerHTML = stateHtml('loading', 'Testing connection…');
      try {
        const result = await api.testOwnApi(baseUrl, apiKey);
        if (result.ok) {
          ownApiTestPassed = true;
          saveButton.disabled = false;
          ownApiStatusEl.innerHTML = stateHtml('success', '✓ Connection successful');
        } else {
          ownApiTestPassed = false;
          saveButton.disabled = true;
          ownApiStatusEl.innerHTML = stateHtml('error', result.message || 'Connection failed. Please check your API Base URL or API Key.');
        }
      } catch (error) {
        if (error.code === 'AUTH_EXPIRED') { stopKohaStatusWatch(); renderAuth(error.message); return; }
        ownApiTestPassed = false;
        saveButton.disabled = true;
        ownApiStatusEl.innerHTML = stateHtml('error', 'Connection failed. Please check your API Base URL or API Key.');
      } finally {
        testButton.disabled = false;
      }
    });

    saveButton.addEventListener('click', async () => {
      if (!ownApiTestPassed) return;
      const baseUrl = baseUrlInput.value.trim();
      const apiKey = apiKeyInput.value.trim();
      saveButton.disabled = true;
      ownApiStatusEl.innerHTML = stateHtml('loading', 'Saving…');
      try {
        state.ownApiStatus = await api.saveOwnApi(baseUrl, apiKey);
        ownApiStatusEl.innerHTML = stateHtml('success', '✓ Own API connected');
        renderOwnModelSettings();
      } catch (error) {
        if (error.code === 'AUTH_EXPIRED') { stopKohaStatusWatch(); renderAuth(error.message); return; }
        saveButton.disabled = false;
        ownApiStatusEl.innerHTML = stateHtml('error', error.message || 'Connection failed. Please check your API Base URL or API Key.');
      }
    });
  }

  modelButtonsWrap.addEventListener('click', (event) => {
    const button = event.target.closest('.model-btn');
    if (!button) return;
    const requested = button.dataset.model;

    // Your Own Model is never gated by modelAccess (see modelButtonsHtml) --
    // selecting it just opens its settings; whether it's actually usable
    // depends on whether it's connected, shown inside that panel itself.
    if (requested === 'MODEL_OWN') {
      state.selectedModel = requested;
      modelStatus.innerHTML = '';
      renderModelButtons();
      renderOwnModelSettings();
      return;
    }

    if (!state.modelAccess.includes(requested)) {
      // Client-side only -- no backend call needed to know a model this
      // account isn't authorized for is unavailable. Exact wording and
      // contact link per spec: no "NVIDIA"/"OpenAI"/tier/plan/API mention.
      modelStatus.innerHTML = `
        ${stateHtml('error', `${escapeHtml(MODEL_DISPLAY_NAMES[requested] || requested)} is not available for your account. Please contact the administrator to upgrade access.`)}
        <p class="hint">Contact: <a href="mailto:${ACTIVATION_CONTACT_EMAIL}">${ACTIVATION_CONTACT_EMAIL}</a></p>
      `;
      return;
    }
    state.selectedModel = requested;
    modelStatus.innerHTML = '';
    ownModelSettingsEl.hidden = true;
    renderModelButtons();
  });

  const bookCard = app.querySelector('#book-card');
  const bookStatus = app.querySelector('#book-status');
  const ddcCard = app.querySelector('#ddc-card');
  const ddcStatus = app.querySelector('#ddc-status');
  const marcCard = app.querySelector('#marc-card');
  const marcStatus = app.querySelector('#marc-status');
  const fillKohaButton = app.querySelector('#fill-koha');
  const fillStatus = app.querySelector('#fill-status');
  const lookupStatus = app.querySelector('#lookup-status');
  const lookupSubmit = app.querySelector('#lookup-submit');
  const lookupForm = app.querySelector('#lookup-form');
  const isbnInput = app.querySelector('#isbn-input');
  const cancelLookupButton = app.querySelector('#cancel-lookup');
  const newLookupButton = app.querySelector('#new-lookup');

  // A physical USB/Bluetooth barcode scanner is, to the browser, an
  // ordinary (very fast) keyboard -- there is no special "scanner event" to
  // listen for. The only way scanned characters land in the ISBN field is
  // if that field already has keyboard focus when the scan happens, so the
  // fix here is entirely about focus management: focus the ISBN field
  // whenever it's safe to (panel open, after a scan cycle finishes), and
  // never touch focus while the librarian is typing somewhere else (chat,
  // or any other input/textarea) -- see item 8: scanner characters must
  // never reach the chatbot, and the only way to guarantee that is to never
  // steal focus into the ISBN field out from under an input the librarian
  // is actively using.
  function isTypingElsewhere() {
    const active = document.activeElement;
    if (!active || active === isbnInput) return false;
    const tag = active.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable;
  }

  function focusIsbnInputIfIdle() {
    if (isTypingElsewhere()) return;
    isbnInput.focus();
  }

  // Ready for the next scan: open panel -> focus immediately, no click
  // required (item 2).
  focusIsbnInputIfIdle();

  function renderBook() {
    if (!state.metadata) { bookCard.hidden = true; return; }
    bookCard.hidden = false;
    bookStatus.innerHTML = bookDetailsHtml(state.metadata);
  }

  function renderDdcSection() {
    if (!state.ddcDecision) { ddcCard.hidden = true; return; }
    ddcCard.hidden = false;
    ddcStatus.innerHTML = ddcHtml(state.ddcDecision, state.ddcSource);
  }

  function updateFillAvailability() {
    const ddcApproved = state.ddcDecision?.approval_status === 'APPROVED';
    const marcValid = state.marcResult?.validation?.valid === true;
    const hasPlan = Array.isArray(state.marcResult?.koha_fill?.fields) && state.marcResult.koha_fill.fields.length > 0;
    fillKohaButton.disabled = !(ddcApproved && marcValid && hasPlan);
  }

  function renderMarcSection() {
    if (!state.marcResult) { marcCard.hidden = true; return; }
    marcCard.hidden = false;
    marcStatus.innerHTML = marcHtml(state.marcResult);
    updateFillAvailability();
  }

  const RETRY_BUTTON_HTML = '<button type="button" class="secondary full" id="retry-lookup">Retry lookup</button>';
  const RETRY_ANALYSIS_BUTTON_HTML = '<button type="button" class="secondary full" id="retry-analysis">Retry analysis</button>';

  // retryFn, when given, gets its own "Retry analysis" button wired up
  // instead of (or alongside) the plain "Retry lookup" one -- used for a
  // DDC/MARC failure, where the book evidence already collected must never
  // be thrown away and re-scraped just to try the AI step again (product
  // spec items 10/17/21).
  function handleWorkflowError(error, targetEl, { withRetry = false, retryFn = null } = {}) {
    if (error.code === 'AUTH_EXPIRED') {
      stopKohaStatusWatch();
      renderAuth(error.message);
      return;
    }
    // Not a session problem -- the account is authenticated fine, it just
    // isn't authorized for the model it (or a manually crafted request)
    // asked for. Exact wording and the clickable contact link per product
    // spec section 6/19 -- never "upgrade your plan" language.
    if (error.code === 'MODEL_NOT_AUTHORIZED') {
      const email = error.contactEmail || ACTIVATION_CONTACT_EMAIL;
      const modelName = MODEL_DISPLAY_NAMES[error.requestedModel] || 'This model';
      targetEl.innerHTML = `
        ${stateHtml('error', `${escapeHtml(modelName)} is not available for your account. Please contact the administrator to upgrade access.`)}
        <p class="hint">Contact: <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
      `;
      newLookupButton.hidden = false;
      return;
    }
    // Your Own Model was selected but never successfully connected --
    // direct the librarian back to the settings panel rather than showing
    // a generic failure (this is not a session or provider outage).
    if (error.code === 'OWN_API_NOT_CONFIGURED') {
      targetEl.innerHTML = stateHtml('error', error.message || 'Your Own Model is not connected yet. Add your API Base URL and API Key above.');
      newLookupButton.hidden = false;
      return;
    }
    // A bare "temporarily unavailable" with no way forward is exactly the
    // dead end product spec item 9 calls out -- this is almost always a
    // slow/stalled AI provider call (see the bounded per-call timeouts in
    // llm/router.js / isbnLookup.js), which fails within tens of seconds
    // rather than hanging, so a retry using the SAME already-collected
    // evidence is normally the right next step.
    const timedOut = error.code === 'BACKEND_UNAVAILABLE' || error.code === 'EXTENSION_ERROR' || error.code === 'EMPTY_RESPONSE';
    const message = timedOut ? 'AutoCat is taking longer than expected to respond. Your book evidence is still here.' : error.message;
    const retryButtonsHtml = (retryFn ? RETRY_ANALYSIS_BUTTON_HTML : '') + (withRetry ? RETRY_BUTTON_HTML : '');
    targetEl.innerHTML = stateHtml('error', message) + retryButtonsHtml;
    if (retryFn) targetEl.querySelector('#retry-analysis')?.addEventListener('click', retryFn);
    newLookupButton.hidden = false;
  }

  // -- The single automatic workflow: analyze -> classify -> generate MARC
  // (product spec section 33). There is no separate "approve DDC" step here
  // or anywhere in the UI: the backend already returns the recommendation
  // auto-accepted as the current working classification (see
  // ddcApprovalService.saveDdcDecision), so MARC generation follows
  // immediately. Re-entrant: used by a fresh lookup, the chat panel (after
  // a correction), and the "Retry analysis" button -- always against
  // whatever state.metadata already holds, never re-running web research.
  //
  // myLookupId is the lookupId this call belongs to (captured by the
  // caller); if state.lookupId has moved on by the time an awaited step
  // resolves -- a newer ISBN lookup started, or Cancel was clicked -- this
  // stale result is discarded rather than overwriting a newer lookup's UI
  // (product spec item 13).
  async function runDdcAndMarc(myLookupId) {
    cancelLookupButton.hidden = false;
    newLookupButton.hidden = true;
    ddcCard.hidden = false;
    ddcStatus.innerHTML = stateHtml('loading', 'Analyzing the book…');
    marcCard.hidden = true;
    state.marcResult = null;
    let recommendation;
    try {
      recommendation = await api.recommendDdc(state.metadata, state.selectedModel);
    } catch (error) {
      if (myLookupId !== state.lookupId) return;
      handleWorkflowError(error, ddcStatus, { retryFn: () => runDdcAndMarc(state.lookupId) });
      cancelLookupButton.hidden = true;
      return;
    }
    if (myLookupId !== state.lookupId) return;
    state.ddcId = recommendation.id;
    state.ddcDecision = recommendation.decision;
    state.ddcSource = 'ai';
    renderDdcSection();

    marcCard.hidden = false;
    marcStatus.innerHTML = stateHtml('loading', 'Preparing MARC…');
    try {
      const marc = await api.generateMarc(state.metadata, state.ddcDecision);
      if (myLookupId !== state.lookupId) return;
      state.marcResult = marc;
      renderMarcSection();
    } catch (error) {
      if (myLookupId !== state.lookupId) return;
      handleWorkflowError(error, marcStatus, { retryFn: () => runDdcAndMarc(state.lookupId) });
    } finally {
      if (myLookupId === state.lookupId) cancelLookupButton.hidden = true;
    }
    if (myLookupId === state.lookupId) newLookupButton.hidden = false;
  }

  // Single entry point for starting a lookup, whatever triggered it (Look
  // up click, Enter from manual typing or a scanner, Tab from a scanner).
  // Guarded against re-entry so a scanner double-firing Enter+Tab, or a
  // second scan landing mid-request, can't start two lookups at once --
  // Cancel lookup (below) resets lookupInFlight immediately rather than
  // waiting for the superseded request to actually settle, so a librarian
  // can always start scanning the next book right away (product spec item 12).
  let lookupInFlight = false;
  async function runLookup(rawIsbn) {
    if (lookupInFlight) return;
    const normalized = normalizeIsbnValue(rawIsbn);
    if (!normalized) return;
    if (!looksLikeIsbn(normalized)) {
      lookupStatus.innerHTML = stateHtml('error', 'Please scan a valid ISBN.');
      return;
    }

    const myLookupId = ++state.lookupId;
    lookupInFlight = true;
    lookupSubmit.disabled = true;
    cancelLookupButton.hidden = false;
    newLookupButton.hidden = true;
    // Show the normalized value (trimmed, hyphens stripped) but NEVER clear
    // it -- the librarian needs it visible for retry, chat discussion, and
    // MARC generation even if this lookup fails. Select it instead, so a
    // following scanner burst naturally overwrites it rather than appending.
    isbnInput.value = normalized;
    isbnInput.select();
    bookCard.hidden = true;
    ddcCard.hidden = true;
    marcCard.hidden = true;
    lookupStatus.innerHTML = stateHtml('loading', 'Looking up this ISBN…');
    try {
      const body = await api.lookupIsbn(normalized, state.selectedModel);
      if (myLookupId !== state.lookupId) return; // superseded or cancelled
      if (body.not_found) {
        lookupStatus.innerHTML = notFoundHtml();
        bindRetry(normalized);
        newLookupButton.hidden = false;
        return;
      }
      state.isbn = normalized;
      state.metadata = body;
      lookupStatus.innerHTML = body.partial
        ? stateHtml('info', 'Partial metadata found -- some fields could not be verified.')
        : '';
      renderBook();
      await runDdcAndMarc(myLookupId);
    } catch (error) {
      if (myLookupId !== state.lookupId) return; // superseded or cancelled
      handleWorkflowError(error, lookupStatus, { withRetry: true });
      bindRetry(normalized);
    } finally {
      // Only the lookup that's still current gets to touch the shared
      // in-flight flag/buttons -- a stale call's finally block must not
      // clobber whatever a newer lookup (or Cancel) already set.
      if (myLookupId === state.lookupId) {
        lookupInFlight = false;
        lookupSubmit.disabled = false;
        cancelLookupButton.hidden = true;
        // Ready for the next scan (item 7) -- but never yank focus away from
        // the chat panel or any other field the librarian is actively using.
        focusIsbnInputIfIdle();
      }
    }
  }

  function notFoundHtml() {
    return stateHtml('error', 'No reliable metadata found for this ISBN.') + RETRY_BUTTON_HTML;
  }

  // Wires up a "Retry lookup" button appended after an error, if one is
  // present in the current lookup-status markup. The ISBN stays in the
  // input the whole time (never cleared), so retry just re-runs with it.
  function bindRetry(isbnForRetry) {
    const retryButton = lookupStatus.querySelector('#retry-lookup');
    if (!retryButton) return;
    retryButton.addEventListener('click', () => runLookup(isbnForRetry));
  }

  // Cancel lookup (product spec item 12): bumping lookupId is what actually
  // "cancels" anything already in flight -- every awaited step across
  // runLookup/runDdcAndMarc checks it and silently discards a stale result,
  // which is the documented fallback for a request that can't technically
  // be aborted mid-flight. The extension itself becomes idle again
  // immediately, without waiting for the superseded request to resolve.
  cancelLookupButton.addEventListener('click', () => {
    state.lookupId += 1;
    lookupInFlight = false;
    lookupSubmit.disabled = false;
    cancelLookupButton.hidden = true;
    newLookupButton.hidden = false;
    lookupStatus.innerHTML = stateHtml('info', 'Lookup cancelled.');
    ddcCard.hidden = true;
    marcCard.hidden = true;
    focusIsbnInputIfIdle();
  });

  // New lookup (product spec item 14): clears the book/DDC/MARC result and
  // any error so the librarian can start clean -- but never the session,
  // the selected AI model, or (per item 15) forces the librarian to retype
  // an ISBN that's still sitting right there if they just want to correct it.
  newLookupButton.addEventListener('click', () => {
    state.lookupId += 1; // invalidate anything still in flight
    lookupInFlight = false;
    state.isbn = null;
    state.metadata = null;
    state.ddcId = null;
    state.ddcDecision = null;
    state.marcResult = null;
    state.chatPendingField = null;
    bookCard.hidden = true;
    ddcCard.hidden = true;
    marcCard.hidden = true;
    lookupStatus.innerHTML = '';
    cancelLookupButton.hidden = true;
    newLookupButton.hidden = true;
    lookupSubmit.disabled = false;
    isbnInput.value = '';
    isbnInput.focus();
  });

  lookupForm.addEventListener('submit', (event) => {
    // Native form submission already fires on Enter with a single text
    // input -- this is what makes "scan + Enter" work exactly like manual
    // typing + Enter, with no scanner-specific code needed.
    event.preventDefault();
    runLookup(isbnInput.value);
  });

  // Scanners that terminate with Tab instead of Enter never fire `submit`
  // (Tab just moves focus) -- capture it here, before focus actually
  // changes, and start the lookup ourselves. `preventDefault` is
  // deliberately NOT called: normal Tab navigation for the rest of the
  // panel must keep working (item 5).
  isbnInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const normalized = normalizeIsbnValue(isbnInput.value);
    if (normalized && looksLikeIsbn(normalized)) runLookup(normalized);
  });

  fillKohaButton.addEventListener('click', async () => {
    if (fillKohaButton.disabled || !state.marcResult?.koha_fill) return;
    fillKohaButton.disabled = true;
    fillStatus.innerHTML = stateHtml('loading', 'Filling MARC fields…');
    try {
      const ddcApproved = state.ddcDecision?.approval_status === 'APPROVED';
      const result = await koha.fillKoha(state.marcResult.koha_fill, ddcApproved);
      const filled = result.filled?.length ?? 0;
      const conflicts = result.conflicts?.length ?? 0;
      const failed = result.failed?.length ?? 0;
      let summary = `${filled} field${filled === 1 ? '' : 's'} filled`;
      if (conflicts) summary += `, ${conflicts} conflict${conflicts === 1 ? '' : 's'} need${conflicts === 1 ? 's' : ''} review`;
      if (failed) summary += `, ${failed} failed`;
      fillStatus.innerHTML = `
        ${stateHtml(failed || conflicts ? 'info' : 'success', filled ? `MARC fields filled — ${summary}` : 'No new fields were filled')}
        <p class="hint">Nothing was saved -- review the fields in Koha, then save manually.</p>
        ${conflicts ? `<div class="result"><p class="result-heading">Needs your review</p><ul>${result.conflicts.map((c) => `<li>${escapeHtml(c.tag)}${c.subfield ? `$${escapeHtml(c.subfield)}` : ''}: Koha already has “${escapeHtml(c.existing)}”, AutoCat suggests “${escapeHtml(c.proposed)}”</li>`).join('')}</ul></div>` : ''}
      `;
    } catch (error) {
      fillStatus.innerHTML = stateHtml('error', error.message);
    } finally {
      updateFillAvailability();
    }
  });

  // -- Chat: exceptions / corrections only (spec section 34) --------------
  const chatLog = app.querySelector('#chat-log');
  const chatStatus = app.querySelector('#chat-status');
  const chatInput = app.querySelector('#chat-form input[name="message"]');
  const chatSend = app.querySelector('#chat-send');
  const chatClear = app.querySelector('#chat-clear');

  // Clear only wipes the visible conversation and the pending-follow-up
  // marker -- it never touches the ISBN, book metadata, DDC recommendation,
  // MARC record, session, or model selection (product spec: "Clear" is
  // conversation-only, not a reset button).
  chatClear.addEventListener('click', () => {
    chatLog.innerHTML = '';
    chatStatus.innerHTML = '';
    state.chatPendingField = null;
    chatInput.value = '';
    chatInput.focus();
  });

  function appendChatMessage(role, text) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${role}`;
    bubble.textContent = text;
    chatLog.appendChild(bubble);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function mergeMetadataPatch(patch) {
    if (!patch) return;
    const next = { ...state.metadata };
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'keywords_add') {
        next.keywords = [...new Set([...(next.keywords || []), ...value])];
        continue;
      }
      if (key === 'excluded_ddc_add') {
        // A rejected DDC number (e.g. "025 is wrong") is excluded from the
        // next classification pass -- forces real reconsideration rather
        // than just repainting the same number under new text.
        next.excluded_ddc = [...new Set([...(next.excluded_ddc || []), ...value])];
        continue;
      }
      next[key] = value;
      // A cataloguer-entered correction always wins over a source lookup --
      // never silently re-overwritten by a later API result (section 16).
      next.cataloguer_edits = { ...(next.cataloguer_edits || {}), [key]: value };
    }
    state.metadata = next;
    renderBook();
  }

  // Plain-text summary for the chat bubble -- never fabricated, built only
  // from whatever the real backend research call actually returned.
  function formatWebResearchSummary(result) {
    const authors = (result.authors || []).join(', ');
    const lines = [
      'WEB RESEARCH COMPLETED',
      '',
      `ISBN: ${result.isbn}`,
      result.title ? `Title: ${result.title}` : null,
      authors ? `Author: ${authors}` : null,
      result.publisher ? `Publisher: ${result.publisher}` : null,
      result.publish_date ? `Publication year: ${result.publish_date}` : null,
      result.edition ? `Edition: ${result.edition}` : null,
      result.physical_description?.pages ? `Pages: ${result.physical_description.pages}` : null,
      result.description ? `Description: ${result.description}` : null,
    ].filter((line) => line !== null);

    if (result.sources_found?.length) {
      lines.push('', 'SOURCES FOUND', ...result.sources_found.map((s) => `• ${s}`));
    }
    if (result.evidence_status) {
      lines.push('', 'EVIDENCE STATUS', result.evidence_status);
    }
    return lines.join('\n');
  }

  // Ask AutoCat's "check the web" / "check complete web" action (see
  // chatService.js's web_lookup/deep_web_lookup intents): calls the real
  // backend web-research endpoint for the current ISBN, reports the result
  // in the chat log, updates the current book context with whatever was
  // found, and continues straight into DDC/MARC analysis -- the same
  // single automatic workflow a fresh lookup triggers (product spec
  // section 33), not a dead end that just shows text.
  async function runWebResearch({ isbn, deep }) {
    const myLookupId = state.lookupId; // guard against a lookup started/cancelled meanwhile
    chatStatus.innerHTML = stateHtml('loading', deep ? 'Researching the web…' : 'Checking the web…');
    try {
      const researched = await api.researchIsbnWeb(isbn, deep);
      if (myLookupId !== state.lookupId) return;
      chatStatus.innerHTML = '';
      if (researched.not_found) {
        appendChatMessage('assistant', 'I could not find reliable metadata for this ISBN.');
        return;
      }
      appendChatMessage('assistant', formatWebResearchSummary(researched));
      state.isbn = researched.isbn;
      state.metadata = researched;
      renderBook();
      await runDdcAndMarc(myLookupId);
    } catch (error) {
      if (myLookupId !== state.lookupId) return;
      chatStatus.innerHTML = '';
      if (error.code === 'AUTH_EXPIRED') { stopKohaStatusWatch(); renderAuth(error.message); return; }
      appendChatMessage('assistant', 'Sorry, the web research could not be completed just now. Please try again.');
    }
  }

  async function applyDdcOverride(override) {
    const myLookupId = state.lookupId; // guard against a lookup started/cancelled meanwhile
    state.ddcSource = 'cataloguer';
    marcStatus.innerHTML = stateHtml('loading', 'Applying your DDC correction…');
    try {
      const approved = await api.approveDdc(state.ddcId, override.number);
      if (myLookupId !== state.lookupId) return;
      state.ddcDecision = { ...approved.decision, ai_recommendation_overridden: true };
      renderDdcSection();
      const marc = await api.generateMarc(state.metadata, state.ddcDecision);
      if (myLookupId !== state.lookupId) return;
      state.marcResult = marc;
      renderMarcSection();
    } catch (error) {
      if (myLookupId !== state.lookupId) return;
      handleWorkflowError(error, marcStatus, { retryFn: () => applyDdcOverride(override) });
    }
  }

  app.querySelector('#chat-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = chatInput.value.trim();
    if (!message) return;
    appendChatMessage('user', message);
    chatInput.value = '';
    chatSend.disabled = true;
    chatStatus.innerHTML = stateHtml('loading', 'AutoCat is thinking…');
    try {
      const context = {
        isbn: state.isbn,
        metadata: state.metadata,
        ddc: state.ddcId != null ? { id: state.ddcId, decision: state.ddcDecision } : undefined,
        marc_ready: state.marcResult?.validation?.valid === true,
        pending_field: state.chatPendingField,
      };
      const response = await api.chat(message, context);
      chatStatus.innerHTML = '';
      appendChatMessage('assistant', response.reply);
      // A clarifying question sets this on its own response; anything else
      // clears it, so a stale "waiting for an author name" marker never
      // outlives the turn that set it.
      state.chatPendingField = response.pending_field ?? null;

      if (response.request_relookup) {
        state.metadata = null;
        state.ddcDecision = null;
        state.marcResult = null;
        bookCard.hidden = true;
        ddcCard.hidden = true;
        marcCard.hidden = true;
        isbnInput.focus();
        return;
      }

      if (response.web_research) {
        await runWebResearch(response.web_research);
        return;
      }

      if (response.metadata_patch) mergeMetadataPatch(response.metadata_patch);

      if (response.ddc_override?.valid) {
        await applyDdcOverride(response.ddc_override);
        return;
      }

      if (response.needs_reanalysis && state.metadata) {
        await runDdcAndMarc(state.lookupId);
      }
    } catch (error) {
      chatStatus.innerHTML = '';
      if (error.code === 'AUTH_EXPIRED') { stopKohaStatusWatch(); renderAuth(error.message); return; }
      appendChatMessage('assistant', 'Sorry, AutoCat could not process that just now. Please try again.');
    } finally {
      chatSend.disabled = false;
    }
  });
}

boot();
