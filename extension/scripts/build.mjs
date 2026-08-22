// Builds a clean, directly-loadable copy of the extension into
// <repo-root>/dist/extension/ -- manifest.json sits at the root of that
// directory (no extra "Domidexx_AutoCat" or "extension" nesting inside
// dist/), so `dist/extension/` itself is what gets selected in Chrome's
// "Load unpacked", or zipped by scripts/package.mjs.
//
// Only files actually required by the shipped extension are copied
// (manifest.json, src/, assets/) -- no package.json, node_modules,
// scripts/, or other repo/dev-only files end up in the package.
import { cpSync, mkdirSync, rmSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(__dirname, '..');
const repoRoot = resolve(extensionRoot, '..');
const outDir = resolve(repoRoot, 'dist', 'extension');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const entry of ['manifest.json', 'src', 'assets']) {
  cpSync(resolve(extensionRoot, entry), resolve(outDir, entry), { recursive: true });
}

console.log(`[build] Copied manifest.json, src/, assets/ into ${outDir}`);

// Self-verify the output is actually loadable before declaring success --
// "do not claim success without validating the generated extension".
execFileSync(process.execPath, [resolve(__dirname, 'validate.mjs'), outDir], { stdio: 'inherit' });

console.log(`\n[build] Done. Load unpacked from: ${outDir}`);
