// Default to the deployed AutoCat backend. Override via the popup's
// "API base URL" field (stored in chrome.storage.local as apiBaseUrl) when
// pointing at a local server during development.
export const DEFAULT_API_BASE_URL = 'https://domidexx-autocat.onrender.com';

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

export async function getApiBaseUrl() {
  const { apiBaseUrl } = await getStored(['apiBaseUrl']);
  return (apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/$/, '');
}

export async function setApiBaseUrl(url) {
  const cleaned = String(url || '').trim().replace(/\/$/, '');
  await setStored({ apiBaseUrl: cleaned || DEFAULT_API_BASE_URL });
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
  const [token, baseUrl, deviceId] = await Promise.all([
    getSessionToken(),
    getApiBaseUrl(),
    getDeviceId(),
  ]);
  const headers = {
    'Content-Type': 'application/json',
    'X-Device-Id': deviceId,
    ...(options.headers || {}),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${baseUrl}${path}`, {
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
