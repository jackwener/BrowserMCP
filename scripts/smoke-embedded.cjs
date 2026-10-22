const { app } = require('electron');
// Surface async host failures in CI instead of Electron's blocking native error dialog.
for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, error => {
  console.error(event, error?.stack ?? error); app.exit(1);
});
const { mkdtempSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const root = process.env.BROWSERMCP_SMOKE_ROOT ?? mkdtempSync(path.join(tmpdir(), 'browsermcp-electron-'));
mkdirSync(path.join(root, 'userData'), { recursive: true });
app.setPath('userData', path.join(root, 'userData'));
app.setPath('sessionData', path.join(root, 'userData'));
process.env.BROWSERMCP_SMOKE_ROOT = root;
app.whenReady().then(() => import('./smoke-embedded.mjs')).catch(error => { console.error(error); app.exit(1); });
