// Internal HTTP layer for the AutoCat backend. Imported ONLY by
// src/background/service-worker.js -- the Side Panel UI never imports this
// file or calls fetch() directly; it talks to the backend exclusively via
// chrome.runtime.sendMessage to the background worker (see
// src/services/api.js for that thin client). This is what keeps API base
// URLs, endpoint paths, and auth headers out of the UI layer entirely.
import { API_BASE_URL, debugLog } from '../services/config.js';

async function getStored(keys) {
  return chrome.storage.local.get(keys);
}

async function setStored(values) {
  return chrome.storage.local.set(values);
}

function randomDeviceId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getDeviceId() {
  const { deviceId } = await getStored(['deviceId']);
  if (deviceId) return deviceId;
  const created = randomDeviceId();
  await setStored({ deviceId: created });
  return created;
}

export async function getSessionToken() {
  const { sessionToken } = await getStored(['sessionToken']);
  return sessionToken ?? null;
}

export async function setSessionToken(token) {
  if (token) {
    await setStored({ sessionToken: token });
  } else {
    await chrome.storage.local.remove('sessionToken');
  }
}

export async function apiFetch(path, options = {}) {
  const [token, deviceId] = await Promise.all([getSessionToken(), getDeviceId()]);
  const headers = {
    'Content-Type': 'application/json',
    'X-Device-Id': deviceId,
    ...(options.headers || {}),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  debugLog('apiFetch', options.method || 'GET', path);
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  return response;
}

export async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}
