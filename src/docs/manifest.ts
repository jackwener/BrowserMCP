import { EMBEDDED_DOCS } from './embedded.js';
/**
 * Docs-as-interface. A documents manifest (Codex documents.json style) decides which markdown
 * is delivered as server `instructions` and which is attached to tool results on demand.
 * Docs are static files bundled with the server, so disk reads are memoized.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_CAPABILITIES, projectApiReference, selectApiReference } from './surface.js';

export type DocMode = 'included' | 'model' | 'lookup';
export interface DocEntry {
  name: string;
  mode: DocMode;
  description?: string;
  when?: { backends?: Array<'extension' | 'electron' | 'none'>; capabilities?: string[] };
}
export interface DocContext { backend: 'extension' | 'electron' | 'none'; capabilities: string[] }

export const DOCS_MANIFEST: DocEntry[] = [
  { name: 'instructions', mode: 'included' },
  { name: 'api-use', mode: 'lookup', description: 'detailed browser actions, locators, network evidence, and recovery' },
  { name: 'safety', mode: 'included' },
  { name: 'tab-lifecycle', mode: 'lookup', description: 'session tabs, claiming user tabs, and finalization', when: { backends: ['extension', 'electron'] } },
  { name: 'sites', mode: 'lookup', description: 'find, run, and define site adapters' },
  { name: 'js-tool', mode: 'model', description: 'compact browser REPL quickstart' },
  { name: 'repl-session', mode: 'lookup', description: 'persistent declarations, output, timeout/reset and execution recovery' },
  { name: 'api-reference', mode: 'model', description: 'the whole object model, generated from its TypeScript declarations' },
  { name: 'errors', mode: 'lookup', description: 'error code families and what to do for each' },
  { name: 'recon', mode: 'lookup', description: 'read before discovering a site’s API endpoints' },
  { name: 'define-tools', mode: 'lookup', description: 'read before defining a site adapter' },
  ...BROWSER_CAPABILITIES.filter((entry) => entry.doc).map((entry): DocEntry => ({ name: entry.doc!, mode: 'model', when: { capabilities: [entry.id] } })),
  { name: 'troubleshooting', mode: 'lookup', description: 'read when the browser bridge fails' },
];

let docsDirCache: string | undefined;
function docsDir(): string {
  if (docsDirCache) return docsDirCache;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const c of [path.resolve(here, '../../docs'), path.resolve(here, '../../../docs'), path.resolve(here, '../docs')]) {
    if (fs.existsSync(path.join(c, 'instructions.md'))) { docsDirCache = c; return c; }
  }
  docsDirCache = path.resolve(here, '../../docs');
  return docsDirCache;
}

const docCache = new Map<string, string | null>();
export function readDoc(name: string): string | null {
  if (!DOCS_MANIFEST.some((doc) => doc.name === name)) return null;
  const hit = docCache.get(name);
  if (hit !== undefined) return hit;
  const file = path.join(docsDir(), `${name}.md`);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  docCache.set(name, text);
  return text;
}

export function readDocForContext(name: string, ctx: DocContext, member?: string): string | null {
  if (!listDocs(ctx).some((entry) => entry.name === name && entry.available)) return null;
  const source = ctx.backend === 'electron' && EMBEDDED_DOCS[name] ? EMBEDDED_DOCS[name] : readDoc(name);
  if (ctx.backend === 'electron' && name === 'js-tool' && source) return source.replace('Create groups with `tabs.group`; edit them with `tabGroups.update`.', 'Only the methods reported by browser.chrome.describe are available; tab groups are host-managed.');
  if (!source || name !== 'api-reference') return source;
  const projected = projectApiReference(source, ctx.capabilities as import('../protocol.js').BrowserFeature[]);
  return member ? selectApiReference(projected, member) : projected;
}

export function listDocs(ctx: DocContext): Array<DocEntry & { available: boolean }> {
  return DOCS_MANIFEST.map((d) => ({ ...d, available: applies(d, ctx) }));
}

export function applies(d: DocEntry, ctx: DocContext): boolean {
  if (d.when?.backends && !d.when.backends.includes(ctx.backend)) return false;
  if (d.when?.capabilities && !d.when.capabilities.every((c) => ctx.capabilities.includes(c))) return false;
  return true;
}

const instructionsCache = new Map<string, string>();
/** Concatenate all `included` docs that apply → MCP server instructions (memoized per context). */
export function buildInstructions(ctx: DocContext): string {
  const key = `${ctx.backend}|${[...ctx.capabilities].sort().join(',')}`;
  const cached = instructionsCache.get(key);
  if (cached !== undefined) return cached;
  const parts: string[] = [];
  for (const d of DOCS_MANIFEST) {
    if (d.mode !== 'included' || !applies(d, ctx)) continue;
    const text = readDocForContext(d.name, ctx);
    if (text) parts.push(text.trim());
  }
  const lookups = DOCS_MANIFEST.filter((d) => d.mode === 'lookup' && applies(d, ctx)).map((d) => `- \`${d.name}\`: ${d.description ?? ''}`);
  if (lookups.length) parts.push(`## Lookup docs (call docs_get)\n${lookups.join('\n')}`);
  const out = parts.join('\n\n');
  instructionsCache.set(key, out);
  return out;
}
