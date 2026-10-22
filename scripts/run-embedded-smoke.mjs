import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electron from 'electron';
const root = mkdtempSync(path.join(tmpdir(), 'browsermcp-electron-'));
try {
  const child = spawn(electron, ['scripts/smoke-embedded.cjs'], { stdio: 'inherit', timeout: 90000, killSignal: 'SIGKILL', env: { ...process.env, BROWSERMCP_SMOKE_ROOT: root } });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
  process.exitCode = code;
} finally { rmSync(root, { recursive: true, force: true }); }
