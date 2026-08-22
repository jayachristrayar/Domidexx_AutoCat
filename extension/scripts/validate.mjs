// Validates that extension/ (or a built package directory passed as the
// first CLI arg) is a well-formed, directly-loadable Manifest V3 Chrome
// extension: manifest.json parses, required fields are present, every
// manifest-referenced file exists on disk, and every match pattern
// (content_scripts and web_accessible_resources) is syntactically valid
// per Chrome's <url-pattern> grammar. Exits non-zero with a specific,
// actionable message on the first problem found -- never a bare
// "invalid manifest".
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ? resolve(process.argv[2]) : resolve(__dirname, '..'));

const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}
function warn(message) {
  warnings.push(message);
}

function fileExists(relPath, describedAs) {
  const full = join(root, relPath);
  if (!existsSync(full) || !statSync(full).isFile()) {
    fail(`${describedAs} references "${relPath}", but that file does not exist at ${full}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// 1. manifest.json exists and is valid JSON
// ---------------------------------------------------------------------
const manifestPath = join(root, 'manifest.json');
if (!existsSync(manifestPath)) {
  fail(`manifest.json not found at ${manifestPath} -- Chrome's "Load unpacked" must point at the folder containing manifest.json directly.`);
  report();
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  fail(`manifest.json is not valid JSON: ${error.message}`);
  report();
}

// ---------------------------------------------------------------------
// 2. manifest_version and required top-level fields
// ---------------------------------------------------------------------
if (manifest.manifest_version !== 3) {
  fail(`manifest_version must be 3 for a Manifest V3 extension, got ${JSON.stringify(manifest.manifest_version)}`);
}
for (const key of ['name', 'version', 'description']) {
  if (!manifest[key] || typeof manifest[key] !== 'string') {
    fail(`manifest.json is missing required string field "${key}"`);
  }
}

// ---------------------------------------------------------------------
// 3. icons
// ---------------------------------------------------------------------
if (!manifest.icons || typeof manifest.icons !== 'object' || Object.keys(manifest.icons).length === 0) {
  fail('manifest.json has no "icons" declared');
} else {
  for (const [size, path] of Object.entries(manifest.icons)) {
    fileExists(path, `icons["${size}"]`);
  }
}
if (manifest.action?.default_icon) {
  for (const [size, path] of Object.entries(manifest.action.default_icon)) {
    fileExists(path, `action.default_icon["${size}"]`);
  }
}

// ---------------------------------------------------------------------
// 4. popup
// ---------------------------------------------------------------------
if (!manifest.action?.default_popup) {
  warn('manifest.json has no action.default_popup -- clicking the toolbar icon will do nothing.');
} else {
  fileExists(manifest.action.default_popup, 'action.default_popup');
}

// ---------------------------------------------------------------------
// 5. background service worker (MV3: must be a service_worker, never
// "scripts"/"page", which are MV2-only and rejected by Chrome for MV3)
// ---------------------------------------------------------------------
if (manifest.background) {
  if (!manifest.background.service_worker) {
    fail('manifest.json "background" must declare a "service_worker" (Manifest V3 has no background page/scripts array).');
  } else {
    fileExists(manifest.background.service_worker, 'background.service_worker');
  }
}

// ---------------------------------------------------------------------
// 6. content scripts + match patterns
// ---------------------------------------------------------------------
const MATCH_PATTERN_RE = /^(\*|https?|file|ftp):\/\/(\*|(?:\*\.)?[^/*]+|)\/.*$|^<all_urls>$/;

function validateMatchPattern(pattern, describedAs) {
  if (pattern === '<all_urls>') {
    warn(`${describedAs} uses "<all_urls>" -- broadest possible match pattern; confirm this is really required.`);
    return;
  }
  if (!MATCH_PATTERN_RE.test(pattern)) {
    fail(`${describedAs} is not a valid Chrome match pattern: "${pattern}". Expected "<scheme>://<host><path>", e.g. "*://*/some/path*".`);
    return;
  }
  if (pattern.startsWith('*://*/*') || pattern === '*://*/*' || pattern === 'http://*/*' || pattern === 'https://*/*') {
    warn(`${describedAs} ("${pattern}") matches every page on every host -- confirm this breadth is actually required.`);
  }
}

if (Array.isArray(manifest.content_scripts)) {
  manifest.content_scripts.forEach((entry, i) => {
    if (!Array.isArray(entry.matches) || entry.matches.length === 0) {
      fail(`content_scripts[${i}] has no "matches" array`);
    } else {
      entry.matches.forEach((m) => validateMatchPattern(m, `content_scripts[${i}].matches`));
    }
    if (!Array.isArray(entry.js) || entry.js.length === 0) {
      fail(`content_scripts[${i}] has no "js" array`);
    } else {
      entry.js.forEach((path) => fileExists(path, `content_scripts[${i}].js`));
    }
  });
}

// ---------------------------------------------------------------------
// 7. web_accessible_resources (only checked if present -- this extension
// currently has none, deliberately, see manifest.json's comment history /
// PR description: nothing needs to be fetched as a chrome-extension://
// URL from page context, so the whole stanza was removed rather than
// given a "fixed" match pattern)
// ---------------------------------------------------------------------
if (manifest.web_accessible_resources) {
  if (!Array.isArray(manifest.web_accessible_resources)) {
    fail('web_accessible_resources must be an array of {resources, matches} objects in Manifest V3 (not a flat array of paths, which was the MV2 format).');
  } else {
    manifest.web_accessible_resources.forEach((entry, i) => {
      if (!Array.isArray(entry.resources) || entry.resources.length === 0) {
        fail(`web_accessible_resources[${i}] has no "resources" array`);
      } else {
        entry.resources.forEach((path) => fileExists(path, `web_accessible_resources[${i}].resources`));
      }
      if (!Array.isArray(entry.matches) || entry.matches.length === 0) {
        fail(`web_accessible_resources[${i}] has no "matches" array`);
      } else {
        entry.matches.forEach((m) => validateMatchPattern(m, `web_accessible_resources[${i}].matches`));
      }
    });
  }
}

// ---------------------------------------------------------------------
// 8. host_permissions
// ---------------------------------------------------------------------
if (Array.isArray(manifest.host_permissions)) {
  manifest.host_permissions.forEach((m, i) => validateMatchPattern(m, `host_permissions[${i}]`));
}

// ---------------------------------------------------------------------
// 9. permissions sanity (informational only -- can't detect "unused" here)
// ---------------------------------------------------------------------
if (Array.isArray(manifest.permissions) && manifest.permissions.includes('<all_urls>')) {
  warn('permissions includes "<all_urls>" -- prefer host_permissions scoped to the actual hosts required.');
}

// ---------------------------------------------------------------------
// 10. no stray nested extension folder (the "select the wrong folder in
// Chrome" failure mode this whole script exists to catch)
// ---------------------------------------------------------------------
if (existsSync(join(root, 'extension', 'manifest.json'))) {
  fail(`Found a nested extension/manifest.json inside ${root} -- Chrome must be pointed at the folder that directly contains manifest.json, not a parent of it.`);
}

report();

function report() {
  for (const w of warnings) console.warn(`[validate] WARNING: ${w}`);
  if (errors.length > 0) {
    console.error(`\n[validate] FAILED — ${errors.length} problem${errors.length === 1 ? '' : 's'} in ${root}:\n`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error('');
    process.exit(1);
  }
  console.log(`[validate] OK — ${root} is a valid, directly-loadable Manifest V3 extension.`);
  console.log(`[validate]   name: ${manifest?.name} v${manifest?.version}`);
  if (warnings.length > 0) console.log(`[validate]   (${warnings.length} warning${warnings.length === 1 ? '' : 's'} above -- not blocking)`);
  process.exit(0);
}
