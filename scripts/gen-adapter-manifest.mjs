// Generate adapters/manifest.json from the adapter modules (run after tsc). `--check` fails instead of writing when stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateAdapterManifest, renderAdapterManifest, manifestPath } from '../dist/src/sites/manifest.js';

const dir = resolve(import.meta.dirname, '..', 'adapters');
const manifest = await generateAdapterManifest(dir);
const text = renderAdapterManifest(manifest);
const file = manifestPath(dir);
let current = null;
try { current = readFileSync(file, 'utf8'); } catch { /* first generation */ }
const count = Object.values(manifest.sites).reduce((n, cmds) => n + Object.keys(cmds).length, 0);
if (process.argv.includes('--check')) {
  if (current !== text) { console.error(`${file} is stale: run \`npm run gen:adapters\``); process.exit(1); }
  console.log(`adapter manifest up to date (${count} commands)`);
} else {
  if (current !== text) writeFileSync(file, text);
  console.log(`adapter manifest → adapters/manifest.json (${Object.keys(manifest.sites).length} sites, ${count} commands)`);
}
