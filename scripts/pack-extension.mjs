// Both distributions share the build; only the Web Store package removes manifest.key.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { EXTENSION_ID } from '../dist/src/host/extension.js';

const mode = process.argv[2];
if (!['store', 'manual'].includes(mode)) throw new Error('Usage: node scripts/pack-extension.mjs <store|manual>');
const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'extension/dist');
const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
if (typeof manifest.key !== 'string' || !manifest.key) throw new Error('Extension build must include manifest.key');
const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
const id = digest.replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
if (id !== EXTENSION_ID) throw new Error(`Extension ID ${id} does not match native host ID ${EXTENSION_ID}`);

const staging = mkdtempSync(join(tmpdir(), 'opencli-pack-'));
const out = resolve(root, `browsermcp-extension-${mode === 'manual' ? 'manual-install' : 'store'}-${manifest.version}.zip`);
try {
  cpSync(dist, staging, { recursive: true });
  if (mode === 'store') delete manifest.key;
  writeFileSync(resolve(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
  rmSync(out, { force: true });
  execFileSync('zip', ['-qr', out, '.'], { cwd: staging });
} finally { rmSync(staging, { recursive: true, force: true }); }
console.log(`${mode} extension zip → ${out} (${mode === 'manual' ? `ID ${id}; extract, then Load unpacked in Chrome` : 'key removed'})`);
