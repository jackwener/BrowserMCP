import { createBrowserCommands, browserHelper, type BrowserHelper, type BrowserCommands } from './commands.js';
import { PageFunction } from '../shared/api-contract.js';
/**
 * The object model's entry: agent.browsers · sites.<site>.<command>() · recon.discover(tab) · tools.define.
 * One surface behind both the typed entry tools and the `js` session.
 */
import type { Runtime } from '../runtime/runtime.js';
import { ActionError } from './errors.js';
import { argSpec } from '../sites/schema.js';
import { discoverEndpoints, type DiscoverResult } from '../recon/discover.js';
import { listDefinedTools, type ToolDefinition } from '../sites/define.js';
import type { DraftExpectation } from '../sites/drafts.js';
import { readDocForContext } from '../docs/manifest.js';
import { Tab } from './tab.js';
import { Browser } from './browser.js';
import type { SessionContext } from './context.js';

export interface AgentApi {
  helper: BrowserHelper;
  agent: { browsers: { getDefault(): Promise<Browser> }; browser: Browser; documentation: { get(name: string): Promise<string | null> } };
  sites: Record<string, unknown> & { search(q: string, limit?: number): Promise<unknown>; list(): Promise<unknown>; enable(site: string, opts?: { write?: boolean }): Promise<{ site: string; tools: string[] }>; disable(site: string): Promise<boolean>; run(site: string, name: string, args?: Record<string, unknown>): Promise<unknown> };
  recon: { discover(tab: Tab, opts?: Parameters<typeof discoverEndpoints>[1]): Promise<DiscoverResult> };
  tools: { define(def: ToolDefinition | (Omit<ToolDefinition, 'func'> & { func?: string | ((ctx: Record<string, unknown>) => unknown) })): ReturnType<Runtime['defineTool']>; try(draftId: string, args: Record<string, unknown>, expect: DraftExpectation): ReturnType<Runtime['tryToolDraft']>; activate(draftId: string): ReturnType<Runtime['activateToolDraft']>; discard(draftId: string): Promise<ReturnType<Runtime['discardToolDraft']>>; list(): Promise<ReturnType<typeof listDefinedTools>>; remove(site: string, name: string): ReturnType<Runtime['removeTool']> };
  session: { id: string };
}

export function createAgentApi(rt: Runtime, sessionId: string): AgentApi & { commands: BrowserCommands } {
  const state = rt.session(sessionId);
  const ctx: SessionContext = { rt, sessionId, state };
  // One user, one Chrome — there is no browser fleet to route among; getDefault is the single accessor.
  const getDefault = async (): Promise<Browser> => {
    if (!rt.browserAvailable()) throw new ActionError('browser_unavailable', 'No browser backend is connected', 'Inspect doctor and the host browser connection.');
    return new Browser(rt.backend() === 'electron' ? 'embedded' : 'chrome', rt.backend() === 'electron' ? 'electron' : 'extension', ctx);
  };

  const siteBase = {
    search: (q: string, limit = 20) => rt.registry.search(q, limit),
    list: async () => rt.registry.sites(),
    enable: async (site: string, opts: { write?: boolean } = {}) => {
      if (!rt.registry.has(site)) throw new ActionError('unknown_site', `no site "${site}"`, 'Use sites.search() to find the right name.');
      state.enabledSites.set(site, { write: Boolean(opts.write) });
      rt.emit('tools-changed', { site });
      const cmds = (await rt.registry.commands(site)).filter((c) => opts.write || c.access === 'read');
      const tools = cmds.map((c) => `${site}_${c.name}`.replace(/[^A-Za-z0-9_-]/g, '_'));
      return { site, tools, commands: cmds.map((c) => ({ tool: `${site}_${c.name}`.replace(/[^A-Za-z0-9_-]/g, '_'), description: c.description, access: c.access, args: argSpec(c.args), result: c.result })), note: 'Adapter commands use the calling session’s browser context.' };
    },
    disable: async (site: string) => { const ok = state.enabledSites.delete(site); if (ok) rt.emit('tools-changed', { site }); return ok; },
    run: async (site: string, name: string, args: Record<string, unknown> = {}) => {
      const r = await rt.runSite(site, name, args, { sessionId });
      if (!r.ok) throw new ActionError(r.error.code, r.error.message, r.error.hint, { site, command: name , ...(r.error.details && { details: r.error.details }) });
      return r.nextCursor ? { rows: r.rows, nextCursor: r.nextCursor } : (r.rows ?? r.value);
    },
  };
  const sites = new Proxy(siteBase as AgentApi['sites'], {
    get(target, prop) {
      if (typeof prop !== 'string' || prop in target) return Reflect.get(target, prop);
      if (!rt.registry.has(prop)) return undefined;
      return new Proxy({}, { get: (_t, cmd) => typeof cmd === 'string' ? (args: Record<string, unknown> = {}) => siteBase.run(prop, cmd.replace(/_/g, '-'), args) : undefined });
    },
    has(target, prop) { return typeof prop === 'string' && (prop in target || rt.registry.has(prop)); },
  });

  const browser = new Browser(rt.backend() === 'electron' ? 'embedded' : 'chrome', rt.backend() === 'electron' ? 'electron' : 'extension', ctx);
  const commands = createBrowserCommands(browser);
  return {
    helper: browserHelper(commands), commands,
    agent: {
      browsers: { getDefault },
      // The single default browser, eagerly available (one user, one Chrome) so `browser.tabs/user/...` works in js
      // without a bootstrap line; ops throw browser_unavailable at call time when Chrome isn't connected.
      browser,
      documentation: { get: async (name: string) => readDocForContext(name, { backend: rt.backend(), capabilities: rt.features() }) },
    },
    sites,
    recon: { discover: async (tab: Tab, opts) => { const log = await tab.network.read({ limit: 2000 }); return tab.use((page) => discoverEndpoints(page, { ...opts, network: log.entries as Array<Record<string, unknown>> })); } },
    tools: {
      // In js, an explicit function can be passed directly; its source is saved as the adapter.
      define: (def: ToolDefinition | (Omit<ToolDefinition, 'func'> & { func?: string | ((ctx: Record<string, unknown>) => unknown) })) => rt.defineTool({ ...def, func: typeof def.func === 'function' ? def.func.toString() : (def.func as unknown) instanceof PageFunction ? (def.func as unknown as PageFunction).source : def.func } as ToolDefinition),
      try: (draftId, args, expect) => rt.tryToolDraft(draftId, args, expect, sessionId),
      activate: (draftId) => rt.activateToolDraft(draftId),
      discard: async (draftId) => rt.discardToolDraft(draftId),
      list: async () => rt.listTools(),
      remove: (site: string, name: string) => rt.removeTool(site, name),
    },
    session: { id: sessionId },
  };
}
