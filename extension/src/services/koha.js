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

export async function detectFields() {
  const data = await call('detectFields', {});
  return data.tags;
}

export async function fillKoha(plan, ddcApproved) {
  return call('fillKoha', { plan, ddcApproved });
}
