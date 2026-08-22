// Packages the built extension (dist/extension/, produced by build.mjs)
// into <repo-root>/release/Domidexx_AutoCat-extension.zip, suitable for
// Chrome Web Store submission or manual distribution. The zip is built
// from *inside* dist/extension/ so manifest.json sits at the zip's own
// root (never Domidexx_AutoCat-extension/extension/manifest.json or any
// other nesting) -- unzipping it produces a folder that is itself
// directly loadable as an unpacked extension.
//
// Also (re)writes release/README-INSTALL.md with plain install steps.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(__dirname, '..');
const repoRoot = resolve(extensionRoot, '..');
const distDir = resolve(repoRoot, 'dist', 'extension');
const releaseDir = resolve(repoRoot, 'release');
const zipPath = resolve(releaseDir, 'Domidexx_AutoCat-extension.zip');

// Always build fresh -- never package a stale/partial dist/.
execFileSync(process.execPath, [resolve(__dirname, 'build.mjs')], { stdio: 'inherit' });

rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

try {
  // `-r` recursive, `-X` strip extended attrs (deterministic-ish output).
  // Run with cwd = distDir so the zip's internal paths are relative to
  // it (manifest.json, not dist/extension/manifest.json).
  execFileSync('zip', ['-r', '-X', zipPath, '.'], { cwd: distDir, stdio: 'inherit' });
} catch (error) {
  console.error(
    '\n[package] Could not run the system "zip" command (' +
      error.message +
      ').\n' +
      '[package] Install it (e.g. `apt-get install zip` / `brew install zip`) and re-run `npm run package`,\n' +
      `[package] or zip the contents of ${distDir} by hand (not the folder itself -- manifest.json must be at the zip root).`
  );
  process.exit(1);
}

if (!existsSync(zipPath)) {
  console.error(`[package] zip command reported success but ${zipPath} was not created.`);
  process.exit(1);
}

const readme = `# Installing the AutoCat Chrome extension

## From this ZIP

1. Unzip \`Domidexx_AutoCat-extension.zip\` -- this produces a folder with
   \`manifest.json\` directly inside it (not nested inside another folder).
2. Open \`chrome://extensions\` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select the folder you just unzipped (the one containing \`manifest.json\`).

Chrome should load the extension immediately, with no "Manifest file is
missing or unreadable" or "Invalid value for 'web_accessible_resources'"
errors.

## From source, without the ZIP

From the repository:

\`\`\`
chrome://extensions
  -> Developer mode
  -> Load unpacked
  -> select Domidexx_AutoCat/extension/
\`\`\`

Select the \`extension/\` folder itself -- the one that directly contains
\`manifest.json\` -- not the repository root.

## Package structure

The ZIP is built from \`dist/extension/\` (see \`extension/scripts/build.mjs\`
and \`extension/scripts/package.mjs\`) and contains only what the extension
needs to run:

\`\`\`
manifest.json
assets/
  logo/
    icon16.png
    icon48.png
    icon128.png
src/
  background/
    service-worker.js
  content-scripts/
    kohaFillEngine.js
    koha-fill.js
  lib/
    api.js
  popup/
    index.html
    popup.css
    popup.js
\`\`\`

No \`package.json\`, \`node_modules\`, or build scripts are included -- those
are development-only files, not part of the shipped extension.
`;

writeFileSync(resolve(releaseDir, 'README-INSTALL.md'), readme);

console.log(`\n[package] Wrote ${zipPath}`);
console.log(`[package] Wrote ${resolve(releaseDir, 'README-INSTALL.md')}`);
