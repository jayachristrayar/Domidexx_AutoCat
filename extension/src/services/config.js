// Internal-only configuration. Nothing in here is ever rendered in the
// Side Panel UI -- the backend base URL, endpoint paths, and the DEBUG
// flag are implementation details, not user-facing settings. There is
// deliberately no UI screen anywhere in this extension for editing the
// backend URL; a developer who needs to point at a local backend flips
// DEBUG below and reloads the unpacked extension, rather than the app
// exposing an API URL field.
//
// Production builds must ship with DEBUG = false.
export const DEBUG = false;

const PRODUCTION_API_BASE_URL = 'https://domidexx-autocat.onrender.com';
const LOCAL_API_BASE_URL = 'http://localhost:10000';

export const API_BASE_URL = DEBUG ? LOCAL_API_BASE_URL : PRODUCTION_API_BASE_URL;

export function debugLog(...args) {
  if (DEBUG) console.log('[AutoCat:debug]', ...args);
}
