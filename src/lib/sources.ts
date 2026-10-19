/** Where adapters live: the built-in corpus (ships with the package) and the user's writable, overriding source. */
import fs from 'node:fs';
import path from 'node:path';
import { BROWSERMCP_DIR } from './paths.js';
import { fileURLToPath } from 'node:url';
import type { Source } from '../sites/loader.js';

// The built-in `adapters/` dir sits at the package root. Walk up from this file until we find it — layout-agnostic, so
// it works both in dev (src/lib/sources.ts) and in the built package (dist/src/lib/sources.js, one level deeper).
function findBuiltinAdapters(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const cand = path.join(dir, 'adapters');
    if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../adapters');
}

export const BUILTIN_ADAPTERS_DIR = findBuiltinAdapters();
export const USER_ADAPTERS_DIR = path.join(BROWSERMCP_DIR, 'adapters');

/** Ordered sources; a later one overrides an earlier one for the same `<site>/<command>`. */
export function defaultSources(): Source[] {
  return [{ dir: BUILTIN_ADAPTERS_DIR, kind: 'builtin' }, { dir: USER_ADAPTERS_DIR, kind: 'user' }];
}
