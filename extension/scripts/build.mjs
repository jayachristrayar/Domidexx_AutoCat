import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = resolve(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

copy(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'));
copy(resolve(root, 'src'), resolve(dist, 'src'));
copy(resolve(root, 'assets'), resolve(dist, 'assets'));

// Ensure icons are real files inside the package (not repo-root symlinks).
for (const size of [16, 48, 128]) {
  cpSync(
    resolve(root, `../assets/logo/icon${size}.png`),
    resolve(dist, `assets/logo/icon${size}.png`)
  );
}

const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
writeFileSync(resolve(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`Extension packaged at ${dist}`);
console.log('Load unpacked in chrome://extensions from the dist/ folder (or extension/ during development).');
