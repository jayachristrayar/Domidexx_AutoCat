// MV3 background service worker.
//
// Three responsibilities:
//  1. Open the Chrome Side Panel when the toolbar icon is clicked (instead
//     of a popup -- there is no action.default_popup in manifest.json).
//  2. Own all backend HTTP communication (AUTOCAT_API messages). The Side
//     Panel never calls fetch() itself; it sends
//     { type: 'AUTOCAT_API', action, payload } via chrome.runtime.sendMessage
//     and gets back { ok, data } or { ok: false, code, message } with an
//     already-human-friendly message -- raw statuses, stack traces, and
//     response bodies never leave this file.
//  3. Own active-tab lookup and Koha-content-script messaging
//     (AUTOCAT_KOHA_ACTION messages). The Side Panel has its own DOM and
//     cannot see the Koha page directly, so it never calls chrome.tabs.*
//     itself either -- this file finds the active tab, confirms it's a
//     Koha "Add MARC record" page, and relays to the content script.
import { apiFetch, readJson, getSessionToken, setSessionToken, getDeviceId } from '../lib/api.js';
import { debugLog } from '../services/config.js';

const KOHA_ADDBIBLIO_PATH = '/cgi-bin/koha/cataloguing/addbiblio.pl';

chrome.runtime.onInstalled.addListener(() => {
  console.log('[AutoCat] Extension installed');
});

// Clicking the toolbar icon opens the side panel on the current tab,
// instead of the default no-op (there's no popup to fall back to).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[AutoCat] Failed to configure side panel behavior:', error));

// ---------------------------------------------------------------------
// Friendly error mapping -- the one place technical failure detail is
// ever looked at. Everything downstream (services/api.js, sidepanel.js)
// only ever sees the resulting `message`. Codes match the vocabulary the
// side panel actually branches on (e.g. AUTH_EXPIRED -> back to login).
// ---------------------------------------------------------------------

function fieldErrorSummary(payload) {
  const fieldErrors = payload?.error?.fieldErrors;
  if (!fieldErrors || typeof fieldErrors !== 'object') return null;
  const parts = Object.entries(fieldErrors).flatMap(([field, messages]) =>
    (messages || []).map((message) => `${field}: ${message}`)
  );
  return parts.length ? parts.join('; ') : null;
}

function friendlyResultFor(response, payload, { onUnauthorized } = {}) {
  if (response.status === 401 || response.status === 403) {
    onUnauthorized?.();
    return { ok: false, code: 'AUTH_EXPIRED', message: 'Your session has expired. Please log in again.' };
  }
  if (response.status === 404) {
    return { ok: false, code: 'NOT_FOUND', message: 'That information could not be found.' };
  }
  if (response.status === 400 || response.status === 422) {
    const detail = fieldErrorSummary(payload) || (typeof payload?.error === 'string' ? payload.error : null);
    return { ok: false, code: 'VALIDATION_ERROR', message: detail || 'Please check the information you entered and try again.' };
  }
  if (response.status >= 500) {
    console.error('[AutoCat] Backend error response:', response.status, payload?.error ?? payload);
    return { ok: false, code: 'BACKEND_UNAVAILABLE', message: 'AutoCat is temporarily unavailable. Please try again.' };
  }
  console.error('[AutoCat] Unexpected backend response:', response.status, payload);
  return { ok: false, code: 'UNKNOWN_ERROR', message: 'Something went wrong. Please try again.' };
}

// Login gets its own error mapping, distinct from friendlyResultFor's
// generic 401/403 -> "session expired" collapse: a login attempt's 403 can
// mean the account is PENDING/REJECTED/DISABLED, and the backend already
// composed the exact, specific, librarian-friendly message for each case
// (userService.accountAccessError) -- that message must reach the Side
// Panel verbatim, not be replaced with a generic "log in again" that would
// be actively misleading (the user IS trying to log in; that's the problem).
// A plain 401 (wrong password) still gets the standard invalid-credentials
// message.
function loginResultFor(response, payload) {
  if (response.status === 403 && payload?.error_class === 'authorization_error' && typeof payload?.error === 'string') {
    return { ok: false, code: 'ACCOUNT_NOT_AUTHORIZED', message: payload.error };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' };
  }
  return friendlyResultFor(response, payload);
}

function networkErrorResult(error) {
  console.error('[AutoCat] Network error reaching AutoCat:', error);
  return { ok: false, code: 'BACKEND_UNAVAILABLE', message: 'Unable to connect to AutoCat. Please check your connection and try again.' };
}

// ---------------------------------------------------------------------
// Backend actions. Each one is a named capability, never a raw path --
// the Side Panel only ever asks for an action by name (see
// src/services/api.js), so it has no way to reference an endpoint path
// even if it wanted to.
// ---------------------------------------------------------------------

async function actionLogin({ email, password }) {
  try {
    const deviceId = await getDeviceId();
    const response = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, device_id: deviceId }),
    });
    const body = await readJson(response);
    if (!response.ok || !body?.token) {
      return loginResultFor(response, body);
    }
    await setSessionToken(body.token);
    return actionGetMe();
  } catch (error) {
    return networkErrorResult(error);
  }
}

// Signup never logs the librarian in (product spec section 1): a new
// account is created PENDING and the backend deliberately issues no
// session token at all, so there is nothing to store here even on
// success. The Side Panel renders the pending-activation message from
// this action's returned data instead of moving into the workspace.
async function actionSignup({ email, password, institutionSlug }) {
  try {
    const response = await apiFetch('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password, institution_slug: institutionSlug }),
    });
    const body = await readJson(response);
    if (!response.ok || body?.status !== 'PENDING') {
      return friendlyResultFor(response, body);
    }
    return { ok: true, data: { status: body.status, message: body.message, contactEmail: body.contact_email } };
  } catch (error) {
    return networkErrorResult(error);
  }
}

async function actionLogout() {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } catch (error) {
    debugLog('logout call failed, clearing local session anyway', error);
  }
  await setSessionToken(null);
  return { ok: true, data: null };
}

async function actionGetMe() {
  const token = await getSessionToken();
  if (!token) return { ok: false, code: 'NOT_LOGGED_IN', message: 'Please log in to continue.' };
  try {
    const response = await apiFetch('/me');
    const body = await readJson(response);
    if (!response.ok) {
      return friendlyResultFor(response, body, { onUnauthorized: () => setSessionToken(null) });
    }
    return { ok: true, data: body };
  } catch (error) {
    return networkErrorResult(error);
  }
}

async function actionLookupIsbn({ isbn }) {
  try {
    const response = await apiFetch(`/records/lookup/${encodeURIComponent(isbn)}`);
    const body = await readJson(response);
    if (!response.ok) return friendlyResultFor(response, body);
    return { ok: true, data: body };
  } catch (error) {
    return networkErrorResult(error);
  }
}

async function actionRecommendDdc({ metadata }) {
  try {
    const response = await apiFetch('/api/ddc/recommend', { method: 'POST', body: JSON.stringify({ metadata }) });
    const body = await readJson(response);
    if (!response.ok) return friendlyResultFor(response, body);
    return { ok: true, data: body };
  } catch (error) {
    return networkErrorResult(error);
  }
}

async function actionApproveDdc({ id, ddcNumber }) {
  if (id == null) {
    console.error('[AutoCat] approveDdc called without a decision id.');
    return { ok: false, code: 'DDC_APPROVAL_FAILED', message: 'The DDC recommendation could not be approved. Please try again.' };
  }
  try {
    const response = await apiFetch(`/api/ddc/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      // ddc_number is only sent when the cataloguer (via chat) is overriding
      // AutoCat's own recommendation with a different, already-validated
      // number; omitted, the backend approves the AI recommendation as-is.
      body: JSON.stringify(ddcNumber ? { action: 'APPROVE', ddc_number: ddcNumber } : { action: 'APPROVE' }),
    });
    const body = await readJson(response);
    if (!response.ok) {
      // Give DDC-approval failures their own code/message rather than the
      // generic bucket -- the two realistic causes here are the session
      // having expired (handled by friendlyResultFor's 401/403 branch,
      // which still applies) or the recommended number failing the
      // backend's own DDC-reference validation (a real 4xx/5xx from
      // ddcApprovalService.js) -- either way "approving the DDC" is what
      // visibly failed, so say that specifically.
      const generic = friendlyResultFor(response, body);
      if (generic.code === 'AUTH_EXPIRED') return generic;
      console.error('[AutoCat] DDC approval failed:', response.status, body?.error ?? body);
      return { ok: false, code: 'DDC_APPROVAL_FAILED', message: 'The DDC recommendation could not be approved. Please try again.' };
    }
    return { ok: true, data: body };
  } catch (error) {
    console.error('[AutoCat] DDC approval request failed:', error);
    return { ok: false, code: 'DDC_APPROVAL_FAILED', message: 'The DDC recommendation could not be approved. Please try again.' };
  }
}

async function actionGenerateMarc({ metadata, ddcApproval }) {
  try {
    const response = await apiFetch('/records/generate-marc', {
      method: 'POST',
      body: JSON.stringify({ metadata, ddc_approval: ddcApproval }),
    });
    const body = await readJson(response);
    // generate-marc responds 422 (a normal "not ready yet" outcome, e.g.
    // DDC not approved) with a real body the caller still needs -- only
    // treat it as a hard failure if there's no usable body at all.
    if (!response.ok && !body?.validation) return friendlyResultFor(response, body);
    return { ok: true, data: body };
  } catch (error) {
    return networkErrorResult(error);
  }
}

async function actionChat({ message, context }) {
  try {
    const response = await apiFetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message, context }),
    });
    const body = await readJson(response);
    if (!response.ok) return friendlyResultFor(response, body);
    return { ok: true, data: body };
  } catch (error) {
    return networkErrorResult(error);
  }
}

const API_ACTIONS = {
  login: actionLogin,
  signup: actionSignup,
  logout: actionLogout,
  getMe: actionGetMe,
  lookupIsbn: actionLookupIsbn,
  recommendDdc: actionRecommendDdc,
  approveDdc: actionApproveDdc,
  generateMarc: actionGenerateMarc,
  chat: actionChat,
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'AUTOCAT_API') return false;

  const handler = API_ACTIONS[message.action];
  if (!handler) {
    console.error('[AutoCat] Unknown API action requested:', message.action);
    sendResponse({ ok: false, code: 'UNKNOWN_ACTION', message: 'Something went wrong. Please try again.' });
    return false;
  }

  Promise.resolve()
    .then(() => handler(message.payload ?? {}))
    .then(sendResponse)
    .catch((error) => sendResponse(networkErrorResult(error)));
  return true; // keep the message channel open for the async response
});

// ---------------------------------------------------------------------
// Koha tab/content-script relay (AUTOCAT_KOHA_ACTION messages). The Side
// Panel asks for a named Koha action; this file finds the active tab,
// confirms it's actually a Koha "Add MARC record" page (matching the
// same path the content script's manifest match pattern targets), and
// relays the underlying message to it via chrome.tabs.sendMessage.
// ---------------------------------------------------------------------

async function findActiveKohaTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { tab: null, error: { ok: false, code: 'KOHA_PAGE_NOT_FOUND', message: 'Please open a Koha Add MARC Record page.' } };
  }
  if (!tab.url || !tab.url.includes(KOHA_ADDBIBLIO_PATH)) {
    return { tab: null, error: { ok: false, code: 'KOHA_PAGE_NOT_FOUND', message: 'Please open a Koha Add MARC Record page.' } };
  }
  return { tab, error: null };
}

async function relayToKohaTab(tab, message) {
  try {
    const result = await chrome.tabs.sendMessage(tab.id, message);
    if (!result) {
      console.error('[AutoCat] Koha content script returned no response for', message.type);
      return { ok: false, code: 'CONTENT_SCRIPT_UNAVAILABLE', message: 'AutoCat could not connect to this Koha page. Please reload the Koha page and try again.' };
    }
    return { ok: true, result };
  } catch (error) {
    // chrome.tabs.sendMessage rejects with "Could not establish
    // connection. Receiving end does not exist." when the content script
    // hasn't loaded on this tab (e.g. the tab was open before the
    // extension was installed/reloaded) -- the expected, common case.
    console.error('[AutoCat] Could not reach the Koha content script:', error);
    return { ok: false, code: 'CONTENT_SCRIPT_UNAVAILABLE', message: 'AutoCat could not connect to this Koha page. Please reload the Koha page and try again.' };
  }
}

async function kohaActionDetectFields() {
  const { tab, error } = await findActiveKohaTab();
  if (error) return error;

  const relayed = await relayToKohaTab(tab, { type: 'AUTOCAT_DETECT_FIELDS' });
  if (!relayed.ok) return relayed;

  const { result } = relayed;
  if (result.status !== 'ok') {
    console.error('[AutoCat] Detect MARC fields failed on the content script side:', result.error);
    if (result.error === 'marc_editor_not_found') {
      return { ok: false, code: 'MARC_FIELDS_NOT_FOUND', message: 'No MARC fields were detected on the current Koha cataloguing page.' };
    }
    return { ok: false, code: 'CONTENT_SCRIPT_UNAVAILABLE', message: 'AutoCat could not connect to this Koha page. Please reload the Koha page and try again.' };
  }
  if (!Array.isArray(result.tags) || result.tags.length === 0) {
    return { ok: false, code: 'MARC_FIELDS_NOT_FOUND', message: 'No MARC fields were detected on the current Koha cataloguing page.' };
  }
  return { ok: true, data: { tags: result.tags } };
}

async function kohaActionFill({ plan, ddcApproved }) {
  const { tab, error } = await findActiveKohaTab();
  if (error) return error;

  const relayed = await relayToKohaTab(tab, { type: 'AUTOCAT_KOHA_FILL', plan, ddcApproved });
  if (!relayed.ok) return relayed;

  const { result } = relayed;
  if (result.status === 'failed' && !Array.isArray(result.filled)) {
    console.error('[AutoCat] MARC fill failed on the content script side:', result.error);
    if (result.error === 'marc_editor_not_found') {
      return { ok: false, code: 'MARC_FIELDS_NOT_FOUND', message: 'No MARC fields were detected on the current Koha cataloguing page.' };
    }
    return { ok: false, code: 'MARC_FILL_FAILED', message: 'AutoCat could not safely fill the requested MARC fields.' };
  }
  return { ok: true, data: result };
}

// Drives the Side Panel's always-visible Koha connection status pill
// (section 26 of the product spec: connected / detecting / not detected /
// detected-but-no-editor). Unlike findActiveKohaTab above, this never
// rejects a non-Koha or non-cataloguing tab as an error -- "not connected"
// is a normal status to report, not a failure.
async function actionGetStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    return { ok: true, data: { state: 'NOT_DETECTED' } };
  }
  if (!/\/cgi-bin\/koha\//i.test(tab.url)) {
    return { ok: true, data: { state: 'NOT_DETECTED' } };
  }
  if (!tab.url.includes(KOHA_ADDBIBLIO_PATH)) {
    return { ok: true, data: { state: 'DETECTED_NO_EDITOR' } };
  }
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'AUTOCAT_PING' });
    if (result?.status === 'ok' && result.ready) {
      return { ok: true, data: { state: 'CONNECTED' } };
    }
    return { ok: true, data: { state: 'DETECTED_NO_EDITOR' } };
  } catch (error) {
    // Content script not injected yet (tab still loading, or the extension
    // was just installed/reloaded on an already-open Koha tab) -- the page
    // IS the right URL, it just isn't ready to talk to yet.
    debugLog('AUTOCAT_PING failed, reporting DETECTING', error);
    return { ok: true, data: { state: 'DETECTING' } };
  }
}

const KOHA_ACTIONS = {
  detectFields: kohaActionDetectFields,
  fillKoha: kohaActionFill,
  getStatus: actionGetStatus,
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'AUTOCAT_KOHA_ACTION') return false;

  const handler = KOHA_ACTIONS[message.action];
  if (!handler) {
    console.error('[AutoCat] Unknown Koha action requested:', message.action);
    sendResponse({ ok: false, code: 'UNKNOWN_ACTION', message: 'Something went wrong. Please try again.' });
    return false;
  }

  Promise.resolve()
    .then(() => handler(message.payload ?? {}))
    .then(sendResponse)
    .catch((error) => {
      console.error('[AutoCat] Koha action threw unexpectedly:', error);
      sendResponse({ ok: false, code: 'CONTENT_SCRIPT_UNAVAILABLE', message: 'AutoCat could not connect to this Koha page. Please reload the Koha page and try again.' });
    });
  return true; // keep the message channel open for the async response
});

// ---------------------------------------------------------------------
// Tab-change broadcast, so the Side Panel's Koha status pill (section 26)
// updates itself the moment the active tab changes or a Koha page finishes
// (re)loading -- the Side Panel never polls chrome.tabs.* directly, it just
// listens for this message and re-asks for getStatus.
// ---------------------------------------------------------------------

function broadcastTabChanged() {
  chrome.runtime.sendMessage({ type: 'AUTOCAT_TAB_CHANGED' }).catch(() => {
    // No listener attached (side panel closed) -- expected and harmless.
  });
}

chrome.tabs.onActivated.addListener(() => broadcastTabChanged());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.status === 'complete' || changeInfo.url)) {
    broadcastTabChanged();
  }
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) broadcastTabChanged();
});
