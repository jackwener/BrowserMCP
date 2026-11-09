import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SiteRegistry, ADAPTER_MANIFEST_FILE, type Source } from '../src/sites/loader.js';
import { generateAdapterManifest, renderAdapterManifest } from '../src/sites/manifest.js';
import { BUILTIN_ADAPTERS_DIR } from '../src/lib/sources.js';
import { ensureUserSource } from '../src/sites/define.js';

const builtin: Source = { dir: BUILTIN_ADAPTERS_DIR, kind: 'builtin' };
/** Every module import the registry performs goes through importDescriptor. */
function spyImports(registry: SiteRegistry) {
  return vi.spyOn(registry as unknown as { importDescriptor(file: string): Promise<unknown> }, 'importDescriptor');
}
/** The same registry with manifests ignored: every command indexed by importing its module, as before manifests. */
function eager(sources: Source[]): SiteRegistry {
  const registry = new SiteRegistry(sources);
  (registry as unknown as { manifest(): null }).manifest = () => null;
  return registry;
}
const QUERIES = ['bilibili hot', 'twitter search', 'B站 热门', '发帖', 'reddit.com', 'gmail send', 'linkedin', 'discord read messages', 'facebook marketplace', 'like', '关注 follow', 'x'];

describe('built-in adapter manifest', () => {
  it('matches the adapter modules (run `npm run gen:adapters` after changing an adapter)', async () => {
    const committed = readFileSync(path.join(BUILTIN_ADAPTERS_DIR, ADAPTER_MANIFEST_FILE), 'utf8');
    expect(committed).toBe(renderAdapterManifest(await generateAdapterManifest(BUILTIN_ADAPTERS_DIR)));
  });

  it('indexes, lists and searches without importing any adapter module, identically to importing them', async () => {
    const lazy = new SiteRegistry([builtin]);
    const imports = spyImports(lazy);
    await lazy.load();
    const reference = eager([builtin]);
    await reference.load();
    expect(lazy.sites()).toEqual(reference.sites());
    for (const site of reference.sites().map((s) => s.site)) expect(await lazy.commands(site)).toEqual(await reference.commands(site));
    for (const q of QUERIES) expect(await lazy.search(q, 100)).toEqual(await reference.search(q, 100));
    expect(lazy.sites().reduce((n, s) => n + s.commands, 0)).toBeGreaterThan(100);
    expect(imports).not.toHaveBeenCalled();
  });

  it('imports exactly the one module a command needs on first use', async () => {
    const registry = new SiteRegistry([builtin]);
    const imports = spyImports(registry);
    await registry.load();
    await registry.search('bilibili hot');
    const cmd = await registry.resolve('bilibili', 'hot');
    expect(typeof cmd.run).toBe('function');
    expect(cmd).toMatchObject({ site: 'bilibili', name: 'hot', source: 'builtin', access: 'read' });
    expect(imports).toHaveBeenCalledTimes(1);
    expect(imports.mock.calls[0][0]).toBe(path.join(BUILTIN_ADAPTERS_DIR, 'bilibili', 'hot.js'));
    await expect(registry.resolve('bilibili', 'nope')).rejects.toMatchObject({ code: 'unknown_command', message: 'Unknown command bilibili/nope' });
    await expect(registry.resolve('nope', 'hot')).rejects.toMatchObject({ code: 'unknown_command', message: 'Unknown command nope/hot' });
    expect(imports).toHaveBeenCalledTimes(1);
  });

  it('still imports user adapters, which override and extend the manifest-described source', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'manifest-user-'));
    try {
      const user = ensureUserSource(path.join(home, 'adapters'));
      const write = (site: string, name: string, description: string) => {
        mkdirSync(path.join(user, site), { recursive: true });
        writeFileSync(path.join(user, site, `${name}.js`), `import { defineAdapter } from '@jackwener/browsermcp/adapter-sdk';\nexport default defineAdapter({ description: ${JSON.stringify(description)}, access: 'read', args: [{ name: 'q', type: 'string' }], async run() { return { value: ${JSON.stringify(description)} }; } });\n`);
      };
      write('bilibili', 'hot', 'User override of hot');
      write('demo', 'ping', 'Ping the demo site');
      const registry = new SiteRegistry([builtin, { dir: user, kind: 'user' }]);
      const imports = spyImports(registry);
      await registry.load();
      expect(imports.mock.calls.map(([file]) => path.relative(user, file)).sort()).toEqual(['bilibili/hot.js', 'demo/ping.js']);
      expect((await registry.commands('bilibili')).find((c) => c.name === 'hot')).toMatchObject({ description: 'User override of hot', source: 'user' });
      expect((await registry.search('demo ping'))[0]).toMatchObject({ site: 'demo', name: 'ping' });
      expect(registry.sites().find((s) => s.site === 'demo')).toMatchObject({ commands: 1, source: 'user' });
      expect(await (await registry.resolve('bilibili', 'hot')).run({ args: {}, tab: {}, sites: {}, recon: {} })).toEqual({ value: 'User override of hot' });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('imports a command file its manifest does not describe', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'manifest-partial-'));
    try {
      const home = ensureUserSource(path.join(dir, 'adapters'));
      const source = path.join(home, 'corpus');
      for (const name of ['one', 'two']) {
        mkdirSync(path.join(source, 'demo'), { recursive: true });
        writeFileSync(path.join(source, 'demo', `${name}.js`), `import { defineAdapter } from '@jackwener/browsermcp/adapter-sdk';\nexport default defineAdapter({ description: 'Demo ${name}', access: 'read', async run() { return 1; } });\n`);
      }
      writeFileSync(path.join(source, ADAPTER_MANIFEST_FILE), JSON.stringify({ format: 1, sites: { demo: { one: { description: 'Demo one', access: 'read', args: [] } } } }));
      const registry = new SiteRegistry([{ dir: source, kind: 'builtin' }]);
      const imports = spyImports(registry);
      await registry.load();
      expect((await registry.commands('demo')).map((c) => c.description)).toEqual(['Demo one', 'Demo two']);
      expect(imports.mock.calls.map(([file]) => path.basename(file))).toEqual(['two.js']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
