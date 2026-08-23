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

    ${decision.alternatives?.length ? `
      <p class="result-heading">Alternative considered</p>
      <ul>${decision.alternatives.slice(0, 2).map((a) => `<li><strong>${escapeHtml(a.number)}</strong> — ${escapeHtml(a.label)}: ${escapeHtml(a.reason_rejected || a.reason_considered || '')}</li>`).join('')}</ul>
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
      </div>
      <button type="button" class="secondary" id="logout">Log out</button>
    </div>

    <div class="card koha-status-card" id="koha-status">${kohaStatusHtml('DETECTING')}</div>

    <div class="card">
      <p class="section-title">ISBN</p>
      <form id="lookup-form" class="row">
        <label><span>ISBN</span><input name="isbn" required placeholder="9780140328721" autocomplete="off" /></label>
        <button type="submit" id="lookup-submit">Look up</button>
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
    isbn: null,
    metadata: null,
    ddcId: null,
    ddcDecision: null,
    ddcSource: 'ai', // 'ai' | 'cataloguer' -- section 41: keep these distinguishable
    marcResult: null,
  };

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
  const isbnInput = lookupForm.querySelector('input[name="isbn"]');

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

  function handleWorkflowError(error, targetEl) {
    if (error.code === 'BACKEND_UNAVAILABLE' || error.code === 'EXTENSION_ERROR' || error.code === 'EMPTY_RESPONSE') {
      targetEl.innerHTML = stateHtml('error', 'AutoCat service is temporarily unavailable. Please try again.');
      return;
    }
    if (error.code === 'AUTH_EXPIRED') {
      stopKohaStatusWatch();
      renderAuth(error.message);
      return;
    }
    targetEl.innerHTML = stateHtml('error', error.message);
  }

  // -- The single automatic workflow: lookup -> analyze -> classify ------
  // -> approve -> generate MARC (product spec section 33). Re-entrant: also
  // used by the chat panel to re-run analysis/MARC after a correction.
  async function runDdcAndMarc() {
    ddcCard.hidden = false;
    ddcStatus.innerHTML = stateHtml('loading', 'Analyzing the book…');
    marcCard.hidden = true;
    state.marcResult = null;
    let recommendation;
    try {
      recommendation = await api.recommendDdc(state.metadata);
    } catch (error) {
      handleWorkflowError(error, ddcStatus);
      return;
    }
    state.ddcId = recommendation.id;
    state.ddcDecision = recommendation.decision;
    state.ddcSource = 'ai';
    renderDdcSection();

    marcCard.hidden = false;
    marcStatus.innerHTML = stateHtml('loading', 'Preparing MARC…');
    try {
      // Auto-adopt AutoCat's own recommendation so MARC can be prepared in
      // one pass; the librarian's real control point is Fill MARC + the
      // manual Koha Save, and a chat correction can still override this
      // before then (see applyDdcOverride below).
      const approved = await api.approveDdc(state.ddcId);
      state.ddcDecision = approved.decision;
      renderDdcSection();
    } catch (error) {
      handleWorkflowError(error, marcStatus);
      return;
    }

    try {
      const marc = await api.generateMarc(state.metadata, state.ddcDecision);
      state.marcResult = marc;
      renderMarcSection();
    } catch (error) {
      handleWorkflowError(error, marcStatus);
    }
  }

  // Single entry point for starting a lookup, whatever triggered it (Look
  // up click, Enter from manual typing or a scanner, Tab from a scanner).
  // Guarded against re-entry so a scanner double-firing Enter+Tab, or a
  // second scan landing mid-request, can't start two lookups at once.
  let lookupInFlight = false;
  async function runLookup(rawIsbn) {
    if (lookupInFlight) return;
    const normalized = normalizeIsbnValue(rawIsbn);
    if (!normalized) return;
    if (!looksLikeIsbn(normalized)) {
      lookupStatus.innerHTML = stateHtml('error', 'Please scan a valid ISBN.');
      return;
    }

    lookupInFlight = true;
    lookupSubmit.disabled = true;
    // Clear immediately so a following scan never appends onto this one,
    // and the field visibly reads as "ready" while this lookup runs.
    isbnInput.value = '';
    bookCard.hidden = true;
    ddcCard.hidden = true;
    marcCard.hidden = true;
    lookupStatus.innerHTML = stateHtml('loading', 'Looking up this ISBN…');
    try {
      const body = await api.lookupIsbn(normalized);
      if (body.not_found) {
        lookupStatus.innerHTML = stateHtml('error', 'ISBN details could not be found.');
        return;
      }
      state.isbn = normalized;
      state.metadata = body;
      lookupStatus.innerHTML = '';
      renderBook();
      await runDdcAndMarc();
    } catch (error) {
      handleWorkflowError(error, lookupStatus);
    } finally {
      lookupInFlight = false;
      lookupSubmit.disabled = false;
      // Ready for the next scan (item 7) -- but never yank focus away from
      // the chat panel or any other field the librarian is actively using.
      focusIsbnInputIfIdle();
    }
  }

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

  async function applyDdcOverride(override) {
    state.ddcSource = 'cataloguer';
    marcStatus.innerHTML = stateHtml('loading', 'Applying your DDC correction…');
    try {
      const approved = await api.approveDdc(state.ddcId, override.number);
      state.ddcDecision = { ...approved.decision, ai_recommendation_overridden: true };
      renderDdcSection();
      const marc = await api.generateMarc(state.metadata, state.ddcDecision);
      state.marcResult = marc;
      renderMarcSection();
    } catch (error) {
      handleWorkflowError(error, marcStatus);
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
      };
      const response = await api.chat(message, context);
      chatStatus.innerHTML = '';
      appendChatMessage('assistant', response.reply);

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

      if (response.metadata_patch) mergeMetadataPatch(response.metadata_patch);

      if (response.ddc_override?.valid) {
        await applyDdcOverride(response.ddc_override);
        return;
      }

      if (response.needs_reanalysis && state.metadata) {
        await runDdcAndMarc();
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
