import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
const out = new URL('../dist/src/electron/', import.meta.url);
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['extension/src/page/index.ts'], bundle: true, format: 'iife', target: 'chrome120', platform: 'browser', outfile: new URL('page.js', out).pathname, logLevel: 'warning' });
for (const name of ['js-worker.mjs', 'js-evaluator.mjs']) copyFileSync(new URL(`../src/mcp/${name}`, import.meta.url), new URL(`../dist/src/mcp/${name}`, import.meta.url));
