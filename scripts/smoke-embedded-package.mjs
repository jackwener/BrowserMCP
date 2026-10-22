import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPackageWithOptions } from '@electron/asar';
import electron from 'electron';
const root = mkdtempSync(path.join(tmpdir(), 'embedded-package-'));
try {
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', root], { stdio: 'pipe' });
  const filename = readdirSync(root).find(name => name.endsWith('.tgz'));
  if (!filename) throw new Error('npm pack produced no archive');
  const application = path.join(root, 'application'); mkdirSync(application);
  writeFileSync(path.join(application, 'package.json'), JSON.stringify({ name: 'embedded-fixture', version: '1.0.0', private: true, type: 'module' }));
  execFileSync('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', path.join(root, filename)], { cwd: application, stdio: 'pipe' });
  const archive = path.join(root, 'app.asar');
  await createPackageWithOptions(application, archive, { unpack: '**/js-*.mjs' });
  const sdk = path.join(archive, 'node_modules/@jackwener/browsermcp/dist/src/embedded/index.js');
  const child = spawn(electron, ['scripts/smoke-embedded.cjs'], { stdio: 'inherit', timeout: 90000, killSignal: 'SIGKILL', env: { ...process.env, BROWSERMCP_SMOKE_ROOT: path.join(root, 'profile'), BROWSERMCP_SMOKE_SDK: pathToFileURL(sdk).href } });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
  process.exitCode = code;
  if (!code) console.log('PASS installed npm package in app.asar');
} finally { rmSync(root, { recursive: true, force: true }); }
