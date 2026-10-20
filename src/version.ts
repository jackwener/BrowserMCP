import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve in source, installed packages and Electron app.asar without using the host's cwd. */
export function getPackageVersion(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
      if (pkg.name === '@jackwener/browsermcp' && typeof pkg.version === 'string') return pkg.version;
    } catch { /* Continue to the owning package. */ }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Cannot resolve BrowserMCP package version; preserve its package.json when bundling');
    directory = parent;
  }
}
