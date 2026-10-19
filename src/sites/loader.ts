/**
 * SourceLoader — the adapter layer. An adapter is a self-describing module at `<source>/<site>/<command>.js` that
 * `export default defineAdapter({ description, access, args, run })`. Identity is the PATH; the module is the definition.
 * There is no manifest and no global registry: the loader lists by `readdir`, resolves by importing the file, and keeps
 * a small in-memory index (rebuilt on directory mtime change) for cross-site search.
 *
 * Sources are an ordered list; a later source overrides an earlier one for the same `<site>/<command>` — so the
 * built-in corpus, the user's `~/.opencli-mcp/adapters`, and agent-defined tools are one mechanism, not three.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineAdapter, type AdapterDescriptor } from '@jackwener/browsermcp/adapter-sdk';
import { argSpec, validateArgDefinitions, type Arg, type ArgView } from './schema.js';

export type SourceKind = 'builtin' | 'user';

export interface Source { dir: string; kind: SourceKind }

export interface AdapterContext {
  args: Record<string, unknown>;
  tab: unknown;
  sites: unknown;
  recon: unknown;
  signal?: AbortSignal;
}

/** A loaded adapter: the descriptor from the module plus its path-derived identity. */
export interface AdapterCommand {
  site: string;
  name: string;
  description: string;
  access: 'read' | 'write';
  domain?: string;
  result?: { kind: 'rows' | 'value'; description: string; fields?: Record<string, string>; paginated?: boolean };
  args: Arg[];
  aliases?: string[];
  source: SourceKind;
  run: (ctx: AdapterContext) => Promise<unknown>;
}

/** One descriptor validation path for built-in, user, and draft adapters. */
export function adapterCommandFromDescriptor(site: string, name: string, source: SourceKind, descriptor: Record<string, unknown>): AdapterCommand {
  const d = defineAdapter(descriptor as unknown as AdapterDescriptor) as unknown as Record<string, unknown>;
  validateArgDefinitions((d.args as Arg[]) ?? []);
  return {
    site, name, source,
    description: String(d.description),
    access: d.access as 'read' | 'write',
    domain: d.domain as string | undefined,
    result: d.result as AdapterCommand['result'],
    args: (d.args as Arg[]) ?? [],
    aliases: d.aliases as string[] | undefined,
    run: d.run as AdapterCommand['run'],
  };
}

const isCommandFile = (f: string): boolean => f.endsWith('.js') && !f.startsWith('_');
const cmdName = (f: string): string => f.replace(/\.js$/, '');
const INTENT_TERMS: Array<[RegExp, string[]]> = [
  [/搜索|查找|搜/, ['search', 'find']], [/发布|发帖|投稿/, ['post', 'publish']],
  [/点赞|喜欢/, ['like', 'upvote']], [/评论|回复/, ['comment', 'reply']],
  [/收藏|书签/, ['bookmark', 'save', 'favorite']], [/关注|订阅/, ['follow', 'subscribe']],
];

export class SiteRegistry {
  loadedAt: number | null = null;
  private index: Array<Omit<AdapterCommand, 'run'>> | null = null;
  private indexStamp = '';

  constructor(private sources: Source[] = []) {}

  /** Replace the source list (later overrides earlier). */
  setSources(sources: Source[]): void { this.sources = sources; this.index = null; }
  addSource(source: Source): void { this.sources.push(source); this.index = null; }

  async load(): Promise<void> { this.index = null; await this.buildIndex(); this.loadedAt = Date.now(); }

  private existingDirs(): Source[] { return this.sources.filter((s) => { try { return fs.statSync(s.dir).isDirectory(); } catch { return false; } }); }

  /** Include file identity: replacing an adapter does not update its parent directory mtime. */
  private stamp(): string {
    const parts: string[] = [];
    for (const s of this.existingDirs()) {
      try { parts.push(`${s.dir}:${fs.statSync(s.dir).mtimeMs}`); } catch { /* ignore */ }
      for (const site of this.siteDirs(s.dir)) {
        const dir = path.join(s.dir, site);
        try {
          parts.push(`${dir}:${fs.statSync(dir).mtimeMs}`);
          for (const name of fs.readdirSync(dir).filter(isCommandFile).sort()) {
            const stat = fs.statSync(path.join(dir, name));
            parts.push(`${name}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`);
          }
        } catch { /* ignore a concurrently removed source */ }
      }
    }
    return parts.join('|');
  }

  private siteDirs(dir: string): string[] {
    try { return fs.readdirSync(dir).filter((d) => { try { return fs.statSync(path.join(dir, d)).isDirectory() && !d.startsWith('.'); } catch { return false; } }); }
    catch { return []; }
  }

  private siteAliases(site: string): string[] {
    const aliases = new Set<string>();
    for (const source of this.existingDirs()) {
      try {
        const metadata = JSON.parse(fs.readFileSync(path.join(source.dir, site, 'site.json'), 'utf8')) as { aliases?: unknown };
        if (Array.isArray(metadata.aliases)) for (const alias of metadata.aliases) if (typeof alias === 'string' && alias.trim()) aliases.add(alias.toLowerCase());
      } catch { /* optional site metadata */ }
    }
    return [...aliases];
  }

  /** site -> command-name -> absolute file path (later source wins). */
  private map(): Map<string, Map<string, string>> {
    const out = new Map<string, Map<string, string>>();
    for (const s of this.existingDirs()) {
      for (const site of this.siteDirs(s.dir)) {
        const siteDir = path.join(s.dir, site);
        let files: string[]; try { files = fs.readdirSync(siteDir); } catch { continue; }
        const bucket = out.get(site) ?? new Map<string, string>();
        for (const f of files) if (isCommandFile(f)) bucket.set(cmdName(f), path.join(siteDir, f));
        out.set(site, bucket);
      }
    }
    return out;
  }

  private kindOf(file: string): SourceKind {
    for (let i = this.sources.length - 1; i >= 0; i--) if (file.startsWith(this.sources[i].dir + path.sep)) return this.sources[i].kind;
    return 'builtin';
  }

  private async importDescriptor(file: string): Promise<Record<string, unknown>> {
    const stat = fs.statSync(file);
    const mod = await import(`${pathToFileURL(file).href}?t=${stat.ino}-${stat.mtimeMs}-${stat.ctimeMs}-${stat.size}`) as { default?: Record<string, unknown> };
    if (!mod.default || typeof mod.default.run !== 'function') throw Object.assign(new Error(`${file} must \`export default defineAdapter({...})\``), { code: 'adapter_load' });
    return mod.default;
  }

  private toCommand(site: string, name: string, file: string, d: Record<string, unknown>): AdapterCommand {
    return adapterCommandFromDescriptor(site, name, this.kindOf(file), d);
  }

  private async buildIndex(): Promise<Array<Omit<AdapterCommand, 'run'>>> {
    const stamp = this.stamp();
    if (this.index && this.indexStamp === stamp) return this.index;
    const map = this.map();
    const out: Array<Omit<AdapterCommand, 'run'>> = [];
    for (const [site, cmds] of map) {
      for (const [name, file] of cmds) {
        try { const { run: _run, ...meta } = this.toCommand(site, name, file, await this.importDescriptor(file)); out.push(meta); }
        catch (err) { process.stderr.write(`[browsermcp] failed to load adapter ${file}: ${(err as Error).message}\n`); }
      }
    }
    this.index = out; this.indexStamp = stamp;
    return out;
  }

  private async all(): Promise<Array<Omit<AdapterCommand, 'run'>>> { return this.buildIndex(); }

  has(site: string): boolean { return this.map().has(site); }

  sites(): Array<{ site: string; aliases: string[]; commands: number; read: number; write: number; domains: string[]; source: SourceKind; sample: string[] }> {
    const idx = this.index ?? [];
    const map = this.map();
    return [...map.entries()].map(([site, cmds]) => {
      const metas = idx.filter((c) => c.site === site);
      return {
        site, aliases: this.siteAliases(site), commands: cmds.size,
        read: metas.filter((c) => c.access === 'read').length,
        write: metas.filter((c) => c.access === 'write').length,
        domains: [...new Set(metas.map((c) => c.domain).filter(Boolean) as string[])],
        source: metas[0]?.source ?? 'builtin',
        sample: [...cmds.keys()].slice(0, 6),
      };
    }).sort((a, b) => a.site.localeCompare(b.site));
  }

  commandNames(site: string): string[] { return [...(this.map().get(site)?.keys() ?? [])].sort(); }
  sourceFile(site: string, name: string): string | undefined { return this.map().get(site)?.get(name); }

  /** Command metadata for a site (from the index; loads it if cold). */
  async commands(site: string): Promise<Array<Omit<AdapterCommand, 'run'>>> { return (await this.all()).filter((c) => c.site === site).sort((a, b) => a.name.localeCompare(b.name)); }

  /** Rank commands for a free-text query, using the in-memory index. */
  async search(query: string, limit = 20): Promise<Array<{ site: string; name: string; description: string; score: number; access: string; domain?: string; args: ArgView[]; result?: AdapterCommand['result'] }>> {
    const normalized = query.toLowerCase();
    const terms = [...normalized.split(/[\s,]+/).filter(Boolean), ...INTENT_TERMS.flatMap(([pattern, words]) => pattern.test(normalized) ? words : [])];
    if (!terms.length) return [];
    const hits: Array<{ site: string; name: string; description: string; score: number; access: string; domain?: string; args: ArgView[]; result?: AdapterCommand['result'] }> = [];
    const siteAliases = new Map<string, string[]>();
    for (const c of await this.all()) {
      if (!siteAliases.has(c.site)) siteAliases.set(c.site, this.siteAliases(c.site));
      const hay = { site: c.site.toLowerCase(), name: c.name.toLowerCase(), desc: c.description.toLowerCase(), domain: (c.domain ?? '').toLowerCase(), aliases: (c.aliases ?? []).join(' ').toLowerCase() };
      let score = 0;
      if ([hay.site, hay.domain, ...(siteAliases.get(c.site) ?? [])].some((name) => name.length >= 2 && normalized.includes(name))) score += 8;
      for (const t of terms) {
        if (hay.site === t) score += 10; else if (hay.site.includes(t)) score += 5;
        if (hay.name === t) score += 6; else if (hay.name.includes(t)) score += 3;
        if (hay.domain.includes(t)) score += 4;
        if (hay.aliases.includes(t)) score += 3;
        if (hay.desc.includes(t)) score += 2;
      }
      if (score > 0) hits.push({ site: c.site, name: c.name, description: c.description, score, access: c.access, domain: c.domain, args: argSpec(c.args), result: c.result });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Load a command with its `run` implementation. Resolves aliases via the index. */
  async resolve(site: string, name: string): Promise<AdapterCommand> {
    const bucket = this.map().get(site);
    let file = bucket?.get(name);
    if (!file) {
      const alias = (await this.all()).find((c) => c.site === site && c.aliases?.includes(name));
      if (alias) file = bucket?.get(alias.name);
    }
    if (!file) throw Object.assign(new Error(`Unknown command ${site}/${name}`), { code: 'unknown_command' });
    return this.toCommand(site, name, file, await this.importDescriptor(file));
  }
}
