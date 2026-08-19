import browser from 'webextension-polyfill';

const API_BASE_URL = 'http://localhost:10000';

async function getSessionToken() {
  const { sessionToken } = await browser.storage.local.get('sessionToken');
  return sessionToken ?? null;
}

export async function apiFetch(path, options = {}) {
  const token = await getSessionToken();
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  return response;
}
