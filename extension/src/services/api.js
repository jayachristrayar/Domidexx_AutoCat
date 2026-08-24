// Thin client the Side Panel UI talks to. Every call here is
// chrome.runtime.sendMessage to the background service worker -- no
// fetch(), no API paths, no auth headers appear anywhere in this file or
// in sidepanel.js. A failed call throws a plain Error whose .message is
// already a friendly, user-safe string (built once, centrally, in
// service-worker.js) -- callers just try/catch and display error.message
// directly.
import { debugLog } from './config.js';

class AutoCatApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AutoCatApiError';
    this.code = code;
  }
}

async function call(action, payload) {
  // Never log the password/payload verbatim, even under DEBUG -- only
  // the action name and which fields were sent.
  debugLog('api call', action, Object.keys(payload || {}));
  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: 'AUTOCAT_API', action, payload });
  } catch (error) {
    // chrome.runtime.sendMessage rejects if the background worker isn't
    // reachable (extension reloading, etc.) -- still not something to
    // show the user verbatim.
    debugLog('sendMessage failed', error);
    throw new AutoCatApiError('Unable to connect to AutoCat. Please try again.', 'EXTENSION_ERROR');
  }
  if (!result) {
    throw new AutoCatApiError('Something went wrong. Please try again.', 'EMPTY_RESPONSE');
  }
  if (!result.ok) {
    throw new AutoCatApiError(result.message || 'Something went wrong. Please try again.', result.code);
  }
  return result.data;
}

export { AutoCatApiError };

export const login = (email, password) => call('login', { email, password });
export const signup = (email, password, institutionSlug) => call('signup', { email, password, institutionSlug });
export const logout = () => call('logout', {});
export const getMe = () => call('getMe', {});
export const lookupIsbn = (isbn) => call('lookupIsbn', { isbn });
export const researchIsbnWeb = (isbn, deep) => call('researchIsbnWeb', { isbn, deep });
export const recommendDdc = (metadata, model) => call('recommendDdc', { metadata, model });
export const approveDdc = (id, ddcNumber) => call('approveDdc', { id, ddcNumber });
export const generateMarc = (metadata, ddcApproval) => call('generateMarc', { metadata, ddcApproval });
export const chat = (message, context) => call('chat', { message, context });

// "Your Own Model" -- additive third AI option, alongside (never replacing)
// Model 1/Model 2 above.
export const getOwnApiStatus = () => call('getOwnApiStatus', {});
export const testOwnApi = (baseUrl, apiKey) => call('testOwnApi', { baseUrl, apiKey });
export const saveOwnApi = (baseUrl, apiKey) => call('saveOwnApi', { baseUrl, apiKey });
