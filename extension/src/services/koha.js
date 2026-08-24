// Side-panel-facing client for Koha DOM operations. The Side Panel has
// its own DOM and cannot see the Koha page directly, so every call here
// is a chrome.runtime.sendMessage to the background service worker
// (AUTOCAT_KOHA_ACTION) -- the background worker is the one that finds
// the active tab, confirms it's a Koha "Add MARC record" page, and
// relays to the content script via chrome.tabs.sendMessage. This mirrors
// src/services/api.js's pattern for backend calls: this file never calls
// chrome.tabs.* itself, and every failure is already a friendly,
// user-safe message by the time it reaches sidepanel.js.
import { debugLog } from './config.js';

class KohaConnectionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'KohaConnectionError';
    this.code = code;
  }
}

async function call(action, payload) {
  debugLog('koha action', action);
  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: 'AUTOCAT_KOHA_ACTION', action, payload });
  } catch (error) {
    debugLog('koha sendMessage failed', error);
    throw new KohaConnectionError('Unable to connect to AutoCat. Please try again.', 'EXTENSION_ERROR');
  }
  if (!result) {
    throw new KohaConnectionError('Something went wrong. Please try again.', 'EMPTY_RESPONSE');
  }
  if (!result.ok) {
    throw new KohaConnectionError(result.message || 'Something went wrong. Please try again.', result.code);
  }
  return result.data;
}

export { KohaConnectionError };

export async function detectFields(tabId) {
  const data = await call('detectFields', { tabId });
  return data.tags;
}

// tabId, when supplied, is the ORIGINAL Koha cataloguing tab captured via
// captureSourceTab() when the lookup started (see sidepanel.js's
// state.sourceTabId) -- Fill MARC must always target that specific tab, not
// whatever tab happens to be active by the time the librarian clicks Fill
// MARC, which may have changed if they switched tabs while research/AI
// reasoning was still running.
export async function fillKoha(plan, ddcApproved, tabId) {
  return call('fillKoha', { plan, ddcApproved, tabId });
}

// Captures the tab the librarian was on when a lookup started, so a later
// Fill MARC can target it explicitly instead of "whatever is active now".
// Returns null when the current tab isn't a Koha cataloguing page -- not an
// error, just nothing to remember yet.
export async function captureSourceTab() {
  try {
    const data = await call('captureSourceTab', {});
    return data.tabId ?? null;
  } catch (error) {
    debugLog('captureSourceTab failed', error);
    return null;
  }
}

// { state: 'NOT_DETECTED' | 'DETECTING' | 'DETECTED_NO_EDITOR' | 'CONNECTED' }
export async function getStatus() {
  try {
    return await call('getStatus', {});
  } catch (error) {
    debugLog('getStatus failed, reporting NOT_DETECTED', error);
    return { state: 'NOT_DETECTED' };
  }
}

// Subscribes to the background worker's AUTOCAT_TAB_CHANGED broadcast (fired
// on tab switch, tab URL/load change, and window focus change) so the Side
// Panel can re-check Koha connection status without polling chrome.tabs.*
// itself. Returns an unsubscribe function.
export function onTabChange(callback) {
  const listener = (message) => {
    if (message?.type === 'AUTOCAT_TAB_CHANGED') callback();
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
