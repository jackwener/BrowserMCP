/** Print one version's CHANGELOG section for the GitHub Release. */
import { readFileSync } from 'node:fs';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-embedded\.\d+)?$/.test(version)) throw new Error('Pass an exact release version');
const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n');
const heading = new RegExp(`^## ${version.replaceAll('.', '\\.')}($|\\s)`);
const start = lines.findIndex((line) => heading.test(line));
if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
let end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
if (end < 0) end = lines.length;
const body = lines.slice(start + 1, end).join('\n').trim();
if (!body) throw new Error(`CHANGELOG.md has no notes for ${version}`);
if (version.includes('-embedded.')) {
  process.stdout.write(`${body}\n\nInstall with \`npm install @jackwener/browsermcp@${version}\` and import \`@jackwener/browsermcp/embedded\` from the Electron main process. No setup or Chrome extension is required.\n`);
  process.exit(0);
}
const extensionVersion = JSON.parse(readFileSync('extension/manifest.json', 'utf8')).version;
process.stdout.write(`${body}\n\n### Manual Chrome extension installation\n\nDownload \`browsermcp-extension-manual-install-${extensionVersion}.zip\`, extract it, then open \`chrome://extensions\`, enable Developer mode, and choose **Load unpacked** on the extracted folder. Disable the Chrome Web Store copy first if it is installed.\n`);
