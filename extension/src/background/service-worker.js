// MV3 background service worker.
//
// Two responsibilities:
//  1. Open the Chrome Side Panel when the toolbar icon is clicked (instead
//     of a popup -- there is no action.default_popup in manifest.json).
//  2. Own all backend HTTP communication. The Side Panel never calls
//     fetch() itself; it sends { type: 'AUTOCAT_API', action, payload }
//     messages here via chrome.runtime.sendMessage and gets back
//     { ok, data } or { ok: false, code, message } with an
//     already-human-friendly message -- raw statuses, stack traces, and
//     response bodies never leave this file.
import { apiFetch, readJson, getSessionToken, setSessionToken, getDeviceId } from '../lib/api.js';
import { debugLog } from '../services/config.js';

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
// only ever sees the resulting `message`.
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
    return { ok: false, code: 'SESSION_EXPIRED', message: 'Your session has expired. Please log in again.' };
  }
  if (response.status === 404) {
    return { ok: false, code: 'NOT_FOUND', message: 'That information could not be found.' };
  }
  if (response.status === 400 || response.status === 422) {
    const detail = fieldErrorSummary(payload) || (typeof payload?.error === 'string' ? payload.error : null);
    return { ok: false, code: 'VALIDATION_ERROR', message: detail || 'Please check the information you entered and try again.' };
  }
  if (response.status >= 500) {
    return { ok: false, code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' };
  }
  return { ok: false, code: 'UNKNOWN_ERROR', message: 'Something went wrong. Please try again.' };
}

function networkErrorResult(error) {
  console.error('[AutoCat] Network error:', error);
  return { ok: false, code: 'NETWORK_ERROR', message: 'Unable to connect to AutoCat. Please check your connection and try again.' };
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
      return friendlyResultFor(response, body);
    }
    await setSessionToken(body.token);
    return actionGetMe();
  } catch (error) {
    return networkErrorResult(error);
  }
}

async function actionSignup({ email, password, institutionSlug }) {
  try {
    const deviceId = await getDeviceId();
    const response = await apiFetch('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password, institution_slug: institutionSlug, device_id: deviceId }),
    });
    const body = await readJson(response);
    if (!response.ok || !body?.token) {
      return friendlyResultFor(response, body);
    }
    await setSessionToken(body.token);
    return actionGetMe();
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

async function actionApproveDdc({ id }) {
  try {
    const response = await apiFetch(`/api/ddc/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ action: 'APPROVE' }),
    });
    const body = await readJson(response);
    if (!response.ok) return friendlyResultFor(response, body);
    return { ok: true, data: body };
  } catch (error) {
    return networkErrorResult(error);
  }
}

async function actionGenerateMarc({ metadata, ddcApproval }) {
  try {
    const response = await apiFetch('/records/generate-marc', {
      method: 'POST',
      body: JSON.stringify({ metadata, ddc_approval: ddcApproval }),
    });
    const body = await readJson(response);
    if (!response.ok) return friendlyResultFor(response, body);
    return { ok: true, data: body };
  } catch (error) {
    return networkErrorResult(error);
  }
}

const ACTIONS = {
  login: actionLogin,
  signup: actionSignup,
  logout: actionLogout,
  getMe: actionGetMe,
  lookupIsbn: actionLookupIsbn,
  recommendDdc: actionRecommendDdc,
  approveDdc: actionApproveDdc,
  generateMarc: actionGenerateMarc,
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'AUTOCAT_API') return false;

  const handler = ACTIONS[message.action];
  if (!handler) {
    sendResponse({ ok: false, code: 'UNKNOWN_ACTION', message: 'Something went wrong. Please try again.' });
    return false;
  }

  handler(message.payload ?? {})
    .then(sendResponse)
    .catch((error) => sendResponse(networkErrorResult(error)));
  return true; // keep the message channel open for the async response
});
