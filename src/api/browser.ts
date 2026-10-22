import { checkArity, parseInput, discoveryOptions, type TabDiscoveryOptions, type TabDiscoveryResult } from '../shared/api-contract.js';
/**
 * Browser — the connected Chrome: tabs (new/list/get/selected/finalize), the user's own tabs (openTabs/claimTab),
 * session naming, capabilities (cdp, viewport, visibility, webmcp) and the model-facing documentation.
 */
import type { RuntimePage } from '../backends/page-types.js';
import { browserCommand, watch } from './streams.js';
import type { StreamOptions, StreamReadOptions, StreamBatch } from '../protocol.js';
import type { CloseUserTabsResult } from '../protocol.js';
import type { ManagedRuntimePage } from '../backends/managed-page.js';
import { ActionError } from './errors.js';
import { buildInstructions, readDocForContext, type DocContext } from '../docs/manifest.js';
import { BROWSER_CAPABILITIES } from '../docs/surface.js';
import { Tab } from './tab.js';
import type { SessionContext } from './context.js';

export class Browser {
  constructor(readonly id: string, readonly type: 'extension' | 'electron', private readonly ctx: SessionContext) {}
  toJSON(): { type: 'Browser'; id: string; backend: string } { return { type: 'Browser', id: this.id, backend: this.type }; }
  private page(): Promise<RuntimePage> { return this.ctx.rt.getBrowserPage(this.ctx.sessionId); }
  private ext(page: RuntimePage): ManagedRuntimePage {
    if (!this.ctx.rt.isManagedPage(page)) throw new ActionError('unsupported_backend', 'This operation needs a managed browser backend', 'Run doctor; make sure Chrome is running with the browsermcp extension.');
    return page;
  }

  /** Chrome APIs through the connected backend. Electron supports an explicit compatibility subset. */
  readonly chrome = {
    call: async (method: string, args: unknown[] = []): Promise<unknown> => browserCommand(this.ctx, 'chrome-api', 'chrome-call', { chromeMethod: method, chromeArgs: args }),
    describe: async (member: string): Promise<unknown> => browserCommand(this.ctx, 'chrome-api', 'chrome-describe', { chromeMethod: member }),
    watch: async (event: string, options?: StreamOptions) => watch(this.ctx, 'chrome', event, options),
  };

  /** This extension's own service-worker logs; not logs of other installed extensions. */
  readonly logs = {
    watch: async (options?: StreamOptions) => watch(this.ctx, 'extension', undefined, options),
    read: async (options: StreamReadOptions = {}): Promise<StreamBatch> => browserCommand(this.ctx, 'extension-logs', 'extension-logs', { streamRead: options }) as Promise<StreamBatch>,
  };

  readonly tabs = {
    new: async (url?: string): Promise<Tab> => {
      const page = await this.page();
      if (url && !/^(https?:\/\/|data:text\/html)/i.test(url)) throw new ActionError('invalid_url', 'Only http(s) (or data:text/html) URLs can be opened', 'Pass an absolute http:// or https:// URL.');
      const id = await page.newTab(url); // the extension creates the tab and waits for its first load
      if (!id) throw new ActionError('tab_create_failed', 'Could not create a tab', 'Retry; if it persists run doctor to check the browser bridge.');
      this.ctx.state.finalized = false; // new tabs after a finalize are the session's again
      const tab = new Tab(id, this.ctx, await this.ctx.rt.pageFor(this.ctx.sessionId, id));
      if (url) {
        // another extension may have taken the navigation over (interstitial, redirect to its own page): say so, do not hand out a tab the debugger cannot attach to
        const landed = await tab.url().catch(() => null);
        if (landed && /^(chrome-extension|chrome-error|chrome):/.test(landed)) { await tab.close().catch(() => {}); throw new ActionError('page_not_loaded', `navigation to ${url} ended on ${landed}`, 'Another Chrome extension intercepted this site (redirect or interstitial); disable it for this site or open the page manually and claim the tab.'); }
      }
      return tab;
    },
    list: async (): Promise<Array<{ id?: string; tabId: number; pending?: true; url?: string; title?: string; active: boolean; selected: boolean; lifecycle?: 'dormant' | 'loading' | 'ready'; origin: 'agent' | 'user'; state: 'active' | 'handoff' }>> => {
      const page = await this.page();
      const tabs = await page.tabs() as Array<{ tabId: number; page?: string; pending?: true; url?: string; title?: string; active: boolean; selected: boolean; lifecycle?: 'dormant' | 'loading' | 'ready'; origin: 'agent' | 'user'; state: 'active' | 'handoff' }>;
      return tabs.map((t) => ({ ...(t.page && { id: t.page }), tabId: t.tabId, ...(!t.page && { pending: true as const }), url: t.url, title: t.title, active: t.active, selected: t.selected, ...(t.lifecycle && { lifecycle: t.lifecycle }), origin: t.origin, state: t.state }));
    },
    get: async (tab: string | { tab?: string; tabId: number }, opts: { timeoutMs?: number } = {}): Promise<Tab> => {
      if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0)) throw new ActionError('invalid_args', 'timeoutMs must be a finite non-negative number.');
      if (typeof tab === 'string') return new Tab(tab, this.ctx);
      if (tab.tab) return new Tab(tab.tab, this.ctx);
      if (!Number.isSafeInteger(tab.tabId)) throw new ActionError('invalid_args', 'Pass a session tab id or an openedTabs entry.');
      const deadline = Date.now() + (opts.timeoutMs ?? 5000);
      do {
        const found = (await this.tabs.list()).find(item => item.tabId === tab.tabId);
        if (found?.id) return new Tab(found.id, this.ctx);
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (true);
      throw new ActionError('tab_not_ready', 'The opened tab has not joined this session.', 'Inspect browser.tabs.list(); the popup may have closed or failed to attach.');
    },
    selected: async (): Promise<Tab | undefined> => {
      const tabs = (await this.tabs.list()).filter((tab) => tab.state === 'active' && tab.id);
      const current = tabs.find((tab) => tab.selected) ?? tabs.find((tab) => tab.active);
      return current?.id ? new Tab(current.id, this.ctx) : undefined;
    },
    finalize: async (opts: { keep?: Array<{ tab: string | Tab; status: 'deliverable' | 'handoff' }> } = {}): Promise<{ closed: string[]; kept: string[]; failed: Array<{ page: string; reason: string }> }> => {
      const page = await this.page();
      const keep = (opts.keep ?? []).map((k) => ({ page: typeof k.tab === 'string' ? k.tab : k.tab?.id, status: k.status }));
      if (keep.length) {
        const owned = await this.tabs.list();
        for (const item of keep) {
          if (!['deliverable', 'handoff'].includes(item.status)) throw new ActionError('invalid_args', 'Unknown retention status');
          if (!owned.some(tab => tab.id === item.page)) {
            const valid = typeof item.page === 'string' && (this.type === 'electron'
              ? /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item.page)
              : /^(0|[1-9]\d*)$/.test(item.page));
            throw new ActionError(valid ? 'page_unavailable' : 'invalid_tab_id', `Cannot retain tab ${JSON.stringify(item.page)}`,
              'Use await tab.markDeliverable(), or pass the full tab.id (not a variable name or numeric tabId). No tabs were cleaned up.',
              { tab: item.page, phase: 'finalize_validation', tabs: owned });
          }
        }
      }
      const result = this.ctx.rt.isManagedPage(page) ? await page.finalize(keep) : (await page.closeWindow(), { closed: [], kept: keep.map((k) => k.page), failed: [] });
      for (const id of [...result.closed, ...result.kept]) this.ctx.rt.forgetPage(this.ctx.sessionId, id);
      this.ctx.state.finalized = result.failed.length === 0;
      if (this.ctx.state.finalized) { this.ctx.state.pages.clear(); this.ctx.state.tabLocks.clear(); }
      return result;
    },
  };

  readonly user = {
    /** Unclaimed supported tabs in the visible scope. Query is trimmed, case-insensitive literal substring of URL OR title (no token splitting). Inspect items, matched, totalInScope, excluded and hasMore; continue with nextOffset. Each call takes a fresh snapshot. */
    openTabs: async (...args: [options?: TabDiscoveryOptions]): Promise<TabDiscoveryResult> => {
      checkArity('Browser.user.openTabs', args.length, 0, 1);
      const options = parseInput('Browser.user.openTabs', discoveryOptions, args[0] === undefined ? {} : args[0]);
      return this.ext(await this.page()).userTabs(options);
    },
    /** Claim by foreground, id, or unique url/title lookup; expected fields verify the tab's current identity. */
    claimTab: async (tab: { tabId?: number; active?: boolean; title?: string; url?: string; expectedUrl?: string; expectedTitle?: string }): Promise<Tab> => {
      const page = this.ext(await this.page());
      const r = await page.claim(tab);
      this.ctx.state.finalized = false;
      return new Tab(r.page, this.ctx, await this.ctx.rt.pageFor(this.ctx.sessionId, r.page), r.tabId);
    },
    /** Close user tabs by Chrome id without claiming or loading their pages. */
    closeTabs: async (tabIds: number[]): Promise<CloseUserTabsResult> => {
      if (!Array.isArray(tabIds) || tabIds.length === 0 || tabIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new ActionError('invalid_args', 'closeTabs needs a non-empty array of positive tabIds');
      return this.ext(await this.page()).closeUserTabs(tabIds);
    },
  };

  async nameSession(name: string): Promise<void> {
    this.ctx.state.name = name;
    const page = await this.page();
    if (this.ctx.rt.isManagedPage(page)) await page.nameSession(name);
  }

  readonly capabilities = {
    list: async (): Promise<Array<{ id: string; description: string }>> => {
      return BROWSER_CAPABILITIES.filter((capability) => this.ctx.rt.hasFeature(capability.id)).map(({ id, description }) => ({ id, description }));
    },
    get: async (id: string): Promise<Record<string, unknown>> => {
      const page = await this.page();
      if (!this.ctx.rt.hasFeature(id as import('../protocol.js').BrowserFeature)) throw new ActionError('capability_unavailable', `${id} is not advertised by the connected extension.`, 'Call browser.capabilities.list() or doctor for current capabilities.');
      this.ctx.state.capabilities.add(id);
      if (id === 'cdp') return { documentation: () => readDocForContext('capabilities/cdp', { backend: this.ctx.rt.backend(), capabilities: this.ctx.rt.features() }) };
      if (id === 'chrome-api') return this.chrome;
      if (id === 'extension-logs') return this.logs;
      if (id === 'viewport') return { set: ({ width, height }: { width: number; height: number }) => page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }), reset: () => page.cdp('Emulation.clearDeviceMetricsOverride', {}) };
      if (id === 'visibility') { const ext = this.ext(page); return { get: () => ext.getVisibility(), set: (v: boolean) => ext.setVisibility(v), documentation: () => readDocForContext('capabilities/visibility', { backend: this.ctx.rt.backend(), capabilities: this.ctx.rt.features() }) }; }
      if (id === 'webmcp') { const sel = await this.tabs.selected(); if (!sel) throw new ActionError('no_tab', 'Open a tab first', 'Call browser.tabs.new (or browser.user.claimTab a user tab) before using this capability.'); return { list: () => sel.webmcp.list(), call: (name: string, input?: Record<string, unknown>) => sel.webmcp.call(name, input), documentation: () => readDocForContext('capabilities/webmcp', { backend: this.ctx.rt.backend(), capabilities: this.ctx.rt.features() }) }; }
      throw new ActionError('unknown_capability', `no capability "${id}"`, 'Use browser.capabilities to see what this backend supports.');
    },
  };

  async documentation(): Promise<string> {
    const ctx: DocContext = { backend: this.type, capabilities: this.ctx.rt.features() };
    return `${buildInstructions(ctx)}\n\n${readDocForContext('js-tool', ctx) ?? ''}\n\n${readDocForContext('api-reference', ctx) ?? ''}`;
  }
}
