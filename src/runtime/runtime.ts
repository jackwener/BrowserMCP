import type { BrowserBackend } from '../backends/backend.js';
import type { ManagedRuntimePage } from '../backends/managed-page.js';
/**
 * Runtime — the resident kernel: site registry, per-MCP-session state, and page backends.
 * Lives inside the Chrome-spawned host. The stdio launcher proxies to this runtime.
 */
import type { ObserveResult } from '../api/tab.js';
import { EventEmitter } from 'node:events';
import type { ExtensionBridge } from '../host/bridge.js';
import type { BrowserEvent } from '../protocol.js';
import { PROTOCOL_REVISION, type BrowserFeature } from '../protocol.js';
import { SiteRegistry, type AdapterCommand, type Source } from '../sites/loader.js';
import { runAdapter, type CommandRunResult, type CommandRunError, type PageProvider } from '../sites/executor.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { listDefinedTools, ensureUserSource, deleteTool, type ToolDefinition } from '../sites/define.js';
import { createDraftStore, type DraftStore, type DraftExpectation } from '../sites/drafts.js';
import { createExtensionPage } from '../backends/extension-page.js';
import type { RuntimePage } from '../backends/page-types.js';
import { JsSession } from '../mcp/js-session.js';
import { Tab, createAgentApi, type AgentApi } from '../api/agent.js';

export type Backend = 'extension' | 'electron' | 'none';

export interface RuntimeOptions {
  bridge?: ExtensionBridge | null;
  backend?: BrowserBackend;
  sources?: Source[];
  userAdaptersDir?: string | null;
  sites?: string[];
  sitesWrite?: string[];
  cursor?: boolean;
  log?: (msg: string) => void;
}

export interface SessionState {
  id: string;
  name?: string;
  createdAt: number;
  browserPage?: RuntimePage;
  browserPagePromise?: Promise<RuntimePage>;
  /** One page object per tab (same bridge, own identity); the session page above carries no tab and serves session-scope calls. */
  pages: Map<string, RuntimePage>;
  /** Per-tab serialization of page operations. */
  tabLocks: Map<string, Promise<void>>;
  enabledSites: Map<string, { write: boolean }>;
  capabilities: Set<string>;
  js?: JsSession;
  observationSeq: number;
  /** Most recent immutable observation per tab; replaced on fresh capture, cleared on release. */
  observations: Map<string, ObserveResult>;
  webmcpCatalogs: Map<string, string>;
  /** Document namespace → frame route, shared by handles for the same tab. */
  refFrames: Map<string, Map<string, import('../protocol.js').FrameStep[]>>;
  lastObserve: Map<string, { id: string; text: string }>;
  /** Network entries seen per tab, with monotonically increasing sequence numbers for cursor-based reads. */
  netLog: Map<string, { seq: number; entries: Array<Record<string, unknown> & { seq: number }>; seen: Set<string>; bodyChars: number }>;
  /** Side effects seen in this session, in order; each js call reports the ones recorded while it ran. */
  changes: { seq: number; entries: Array<SessionChange & { seq: number }> };
  /** Sites whose adapters were already suggested to this session. */
  suggestedSites: Set<string>;
  /** Tabs this session flagged as needing the user (reportIssue); cleared when the agent next uses the tab. */
  attention: Map<string, PageIssue & { atRun: number }>;
  /** Last failed tab.act per tab, so a following evaluate or dom click on that tab is reported as a fallback. */
  actFailures: Map<string, { run: number; code: string; target?: string }>;
  finalized: boolean;
}

/** A problem a page shows the agent: detected from the main document's HTTP status, or reported by the agent with tab.reportIssue. */
export type IssueCode = 'auth_required' | 'blocked' | 'rate_limited' | 'http_error' | 'error_page';
export interface PageIssue { code: IssueCode; source: 'detected' | 'agent'; url?: string; status?: number; retryAfterMs?: number; note?: string }
export type SessionChange =
  | { kind: 'opened'; tab: string; tabId: number; url?: string }
  | { kind: 'closed'; tab: string; tabId: number }
  | { kind: 'navigated'; tab: string; url?: string }
  | { kind: 'dialog'; tab: string; dialogType: string; message?: string }
  | { kind: 'issue'; tab: string; issue: PageIssue }
  | { kind: 'toolError'; error: ToolError }
  | { kind: 'fallback'; fallback: ToolFallback };
const MAX_CHANGES = 200;
/** An error a browser API call raised during a js call, whether or not the code caught it. */
export interface ToolError { code: string; api: string; tab?: string; action?: string; target?: string; retryable: boolean }
/** The code took another route after a tool failed on the same tab, e.g. tab.act failed and tab.evaluate followed. */
export interface ToolFallback { from: string; to: string; tab: string; code: string; target?: string }
/** What a js call's result reports about tool friction; absent when nothing failed. */
export interface ToolFriction { toolErrors?: ToolError[]; fallbacks?: ToolFallback[] }
/** Reported with each js call that caused it. Absent fields mean nothing of that kind happened. */
export interface ChangeSummary {
  opened?: Array<{ tab: string; url?: string }>;
  navigated?: Array<{ tab: string; url?: string }>;
  closed?: string[];
  dialogs?: Array<{ tab: string; type: string; message?: string }>;
  issues?: Array<PageIssue & { tab: string }>;
  /** Ready-made commands for a site this session just reached; suggested once per session. */
  sites?: Array<{ site: string; commands: string[]; more?: number }>;
}

export interface DoctorReport {
  backend: Backend;
  browser: { connected: boolean; features: BrowserFeature[] };
  extension: { connected: boolean; protocolMatches: boolean | null; protocolWarning: string | null; version: string | null; protocolRevision: number | null; hostProtocolRevision: number; features: BrowserFeature[] };
  sites: number;
  commands: number;
  definedTools: number;
  sessions: number;
  cursor: boolean;
}

export interface RuntimeEvents {
  'browser-event': [BrowserEvent];
  'features-changed': [BrowserFeature[]];
  'tools-changed': [{ site?: string }];
  log: [string];
}

export class Runtime extends EventEmitter<RuntimeEvents> implements PageProvider {
  readonly registry: SiteRegistry;
  readonly userAdaptersDir: string | null;
  private readonly drafts: DraftStore | null;
  readonly sessions = new Map<string, SessionState>();
  private readonly adapterRuns = new Map<string, Promise<void>>();
  private readonly adapterCallContext = new AsyncLocalStorage<{ sites: Set<string>; retired: boolean; sessionId?: string }>();
  private readonly siteApis = new Map<string, AgentApi>();
  bridge: ExtensionBridge | null;
  private readonly browserBackend?: BrowserBackend;
  private readonly unsubscribeBackend?: () => void;
  readonly cursorEnabled: boolean;
  readonly configSites: string[];
  readonly configSitesWrite: string[];
  readonly startedAt = Date.now();

  constructor(opts: RuntimeOptions = {}) {
    super();
    this.userAdaptersDir = opts.userAdaptersDir ?? null;
    const sources = [...(opts.sources ?? [])];
    if (this.userAdaptersDir && !sources.some(source => source.dir === this.userAdaptersDir)) sources.push({ dir: this.userAdaptersDir, kind: 'user' });
    this.registry = new SiteRegistry(sources);
    this.drafts = this.userAdaptersDir ? createDraftStore(this.userAdaptersDir) : null;
    this.bridge = opts.bridge ?? null;
    this.browserBackend = opts.backend;
    this.cursorEnabled = opts.cursor ?? false;
    this.configSites = opts.sites ?? [];
    this.configSitesWrite = opts.sitesWrite ?? [];
    if (opts.log) this.on('log', opts.log);
    const onEvent = (e: BrowserEvent): void => {
      if ('page' in e && e.page && 'session' in e) {
        const id = e.session.replace(/^mcp:/, ''); const state = this.sessions.get(id);
        if (e.kind === 'tab_closed' || e.kind === 'tab_released' || e.kind === 'tab_detached' || e.kind === 'tab_attached') this.forgetPage(id, e.page);
        if (e.kind === 'tab_navigated' && state) for (const key of state.lastObserve.keys()) if (key.startsWith(`${e.page}:`)) state.lastObserve.delete(key);
        if (state) {
          if (e.kind === 'tab_created') this.recordChange(id, { kind: 'opened', tab: e.page, tabId: e.tabId, ...(e.url && { url: e.url }) });
          else if (e.kind === 'tab_closed') { this.recordChange(id, { kind: 'closed', tab: e.page, tabId: e.tabId }); this.clearAttention(id, e.page); }
          else if (e.kind === 'tab_released') this.clearAttention(id, e.page);
          else if (e.kind === 'tab_navigated') this.recordChange(id, { kind: 'navigated', tab: e.page, ...(e.url && { url: e.url }) });
        }
      }
      if (e.kind === 'dialog' && e.page) {
        for (const state of this.sessions.values()) if (state.pages.has(e.page) || state.changes.entries.some(c => 'tab' in c && c.tab === e.page)) { this.recordChange(state.id, { kind: 'dialog', tab: e.page, dialogType: e.dialogType, ...(e.message && { message: e.message.slice(0, 200) }) }); break; }
      }
      this.emit('browser-event', e);
    };
    this.bridge?.on('event', onEvent);
    this.unsubscribeBackend = this.browserBackend?.subscribe(onEvent);
    this.bridge?.on('hello', () => this.emit('features-changed', this.features()));
    this.bridge?.on('close', () => { for (const s of this.sessions.values()) { s.browserPage = undefined; s.pages.clear(); } this.emit('features-changed', []); });
  }

  async init(): Promise<void> {
    await this.registry.load();
    if (this.userAdaptersDir) ensureUserSource(this.userAdaptersDir);
  }

  backend(): Backend {
    if (this.browserBackend) return this.browserBackend.available ? this.browserBackend.kind : 'none';
    if (this.bridge?.connected) return 'extension';
    return 'none';
  }
  async browserCommand(action: import('../protocol.js').Command['action'], params: Partial<import('../protocol.js').Command> = {}): Promise<{ data: unknown }> {
    if (this.browserBackend?.command) return this.browserBackend.command(action, params);
    if (this.bridge) return this.bridge.send(action, params);
    throw Object.assign(new Error('This browser capability is unavailable'), { code: 'capability_unavailable' });
  }

  browserAvailable(): boolean { return this.backend() !== 'none'; }
  features(): BrowserFeature[] { if (this.browserBackend) return this.browserBackend.features(); return this.bridge?.connected ? this.bridge.extensionFeatures : []; }
  hasFeature(feature: BrowserFeature): boolean { return this.features().includes(feature); }

  session(id: string): SessionState {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, createdAt: Date.now(), pages: new Map(), tabLocks: new Map(), enabledSites: new Map(), capabilities: new Set(), observationSeq: 0, observations: new Map(), refFrames: new Map(), webmcpCatalogs: new Map(), lastObserve: new Map(), netLog: new Map(), changes: { seq: 0, entries: [] }, suggestedSites: new Set(), attention: new Map(), actFailures: new Map(), finalized: false };
      this.sessions.set(id, s);
    }
    return s;
  }

  /** One interactive browser page per MCP session (tabs are page identities on it). */
  async getBrowserPage(sessionId: string): Promise<RuntimePage> {
    const s = this.session(sessionId);
    if (s.browserPage) return s.browserPage;
    if (!s.browserPagePromise) {
      s.browserPagePromise = this.createPage({ session: `mcp:${sessionId}`, surface: 'browser' }).then((p) => { s.browserPage = p; return p; }).finally(() => { s.browserPagePromise = undefined; });
    }
    return s.browserPagePromise;
  }

  /** The page object bound to one tab of a session: commands carry the tab's identity, nothing is switched or shared. */
  async pageFor(sessionId: string, pageId: string): Promise<RuntimePage> {
    const s = this.session(sessionId);
    const existing = s.pages.get(pageId);
    if (existing) return existing;
    const page = await this.createPage({ session: `mcp:${sessionId}`, surface: 'browser', page: pageId });
    s.pages.set(pageId, page);
    return page;
  }
  recordChange(sessionId: string, change: SessionChange): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const log = state.changes;
    log.entries.push({ ...change, seq: ++log.seq });
    if (log.entries.length > MAX_CHANGES) log.entries.splice(0, log.entries.length - MAX_CHANGES);
  }
  /** The agent says the tab needs the user (login, block, error page). The embedding browser shows it; the next use of the tab clears it. */
  flagAttention(sessionId: string, page: { id: string; tabId?: number }, issue: PageIssue, atRun: number): void {
    const state = this.session(sessionId);
    state.attention.set(page.id, { ...issue, atRun });
    this.emit('browser-event', { kind: 'attention', session: `mcp:${sessionId}`, page: page.id, ...(page.tabId !== undefined && { tabId: page.tabId }), reason: issue.code, waiting: true, ...(issue.url && { url: issue.url }), ...(issue.note && { note: issue.note }) });
  }
  clearAttention(sessionId: string, pageId: string, tabId?: number): void {
    const state = this.sessions.get(sessionId);
    const issue = state?.attention.get(pageId);
    if (!state || !issue) return;
    state.attention.delete(pageId);
    this.emit('browser-event', { kind: 'attention', session: `mcp:${sessionId}`, page: pageId, ...(tabId !== undefined && { tabId }), reason: issue.code, waiting: false });
  }
  /** What happened in this session since change `from`: tabs opened/closed/navigated, dialogs, issues, and adapters for sites it reached. */
  async changesSince(sessionId: string, from: number): Promise<ChangeSummary | undefined> {
    const state = this.sessions.get(sessionId);
    if (!state) return undefined;
    const entries = state.changes.entries.filter((c) => c.seq > from);
    const opened = new Map<string, { tab: string; url?: string }>();
    const navigated = new Map<string, { tab: string; url?: string }>();
    const closed: string[] = []; const dialogs: Array<{ tab: string; type: string; message?: string }> = []; const issues: Array<PageIssue & { tab: string }> = [];
    for (const c of entries) {
      if (c.kind === 'opened') opened.set(c.tab, { tab: c.tab, ...(c.url && { url: c.url }) });
      else if (c.kind === 'navigated') {
        const into = opened.get(c.tab) ?? navigated.get(c.tab) ?? { tab: c.tab };
        if (c.url) into.url = c.url;
        if (!opened.has(c.tab)) navigated.set(c.tab, into);
      } else if (c.kind === 'closed') { if (!closed.includes(c.tab)) closed.push(c.tab); }
      else if (c.kind === 'dialog') dialogs.push({ tab: c.tab, type: c.dialogType, ...(c.message && { message: c.message }) });
      else if (c.kind === 'toolError' || c.kind === 'fallback') continue;
      else if (c.kind === 'issue' && !issues.some((i) => i.tab === c.tab && i.code === c.issue.code && i.url === c.issue.url && i.source === c.issue.source)) issues.push({ tab: c.tab, ...c.issue });
    }
    const sites = await this.suggestSites(state, [...opened.values(), ...navigated.values()].map((t) => t.url).filter((u): u is string => Boolean(u)));
    const summary: ChangeSummary = {
      ...(opened.size && { opened: [...opened.values()] }),
      ...(navigated.size && { navigated: [...navigated.values()] }),
      ...(closed.length && { closed }),
      ...(dialogs.length && { dialogs: dialogs.slice(0, 8) }),
      ...(issues.length && { issues: issues.slice(0, 8) }),
      ...(sites.length && { sites }),
    };
    return Object.keys(summary).length ? summary : undefined;
  }
  /** Tool errors and fallbacks recorded since change `from`, in call order. Repeats of one error collapse into a count. */
  frictionSince(sessionId: string, from: number): ToolFriction | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) return undefined;
    const toolErrors: Array<ToolError & { count?: number }> = []; const fallbacks: ToolFallback[] = [];
    for (const c of state.changes.entries) {
      if (c.seq <= from) continue;
      if (c.kind === 'toolError') {
        const last = toolErrors[toolErrors.length - 1];
        if (last && last.code === c.error.code && last.api === c.error.api && last.tab === c.error.tab && last.target === c.error.target && last.action === c.error.action) last.count = (last.count ?? 1) + 1;
        else toolErrors.push({ ...c.error });
      } else if (c.kind === 'fallback') fallbacks.push(c.fallback);
    }
    if (!toolErrors.length && !fallbacks.length) return undefined;
    return { ...(toolErrors.length && { toolErrors: toolErrors.slice(0, 12) }), ...(fallbacks.length && { fallbacks: fallbacks.slice(0, 8) }) };
  }
  private async suggestSites(state: SessionState, urls: string[]): Promise<NonNullable<ChangeSummary['sites']>> {
    const out: NonNullable<ChangeSummary['sites']> = [];
    const hosts = urls.map((u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } }).filter(Boolean);
    if (!hosts.length) return out;
    for (const site of this.registry.sites()) {
      if (state.suggestedSites.has(site.site)) continue;
      if (!site.domains.some((d) => hosts.some((h) => h === d.toLowerCase() || h.endsWith(`.${d.toLowerCase()}`)))) continue;
      state.suggestedSites.add(site.site);
      const commands = (await this.registry.commands(site.site).catch(() => [])).map((c) => c.access === 'write' ? `${c.name} (write)` : c.name);
      out.push({ site: site.site, commands: commands.slice(0, 15), ...(commands.length > 15 && { more: commands.length - 15 }) });
    }
    return out;
  }
  forgetPage(sessionId: string, pageId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.observations.delete(pageId);
    state.refFrames.delete(pageId);
    state.pages.delete(pageId);
    state.tabLocks.delete(pageId);
    for (const cache of [state.webmcpCatalogs, state.lastObserve]) {
      for (const key of cache.keys()) if (key.startsWith(`${pageId}:`)) cache.delete(key);
    }
  }

  /** Bind each adapter call to the site's current live tab; the extension owns that selection. */
  async getAdapterPage(site: string): Promise<RuntimePage> {
    const caller = this.adapterCallContext.getStore()?.sessionId;
    const key = caller ? `mcp:${caller}` : `site:${site}`;
    const session = await this.createPage({ session: key, surface: 'adapter' });
    const tabs = await session.tabs() as Array<{ page?: string; selected: boolean; state: 'active' | 'handoff' }>;
    const active = tabs.filter((tab) => tab.state === 'active');
    const current = active.find((tab) => tab.selected) ?? active[0];
    if (current && !current.page) throw Object.assign(new Error('Adapter tab is not ready'), { code: 'tab_pending', hint: 'Retry the adapter command when its tab has a page handle.' });
    return current?.page ? this.createPage({ session: key, surface: 'adapter', page: current.page }) : session;
  }

  private async createPage(opts: { session: string; surface: 'browser' | 'adapter'; page?: string }): Promise<RuntimePage> {
    if (this.browserBackend) return this.browserBackend.createPage(opts);
    const backend = this.backend();
    if (backend === 'extension' && this.bridge) return createExtensionPage(this.bridge, opts);
    throw Object.assign(new Error('No browser backend is connected'), { code: 'browser_unavailable', hint: 'Run `browsermcp doctor`. Chrome with the browsermcp extension must be running.' });
  }

  /** Adapters run on the browser object model: a Tab bound to the adapter page, plus sites/recon. */
  async toolContext(page: RuntimePage, site: string): Promise<Record<string, unknown>> {
    const sessionId = this.adapterCallContext.getStore()?.sessionId ?? `site:${site}`;
    let api = this.siteApis.get(sessionId);
    if (!api) { api = createAgentApi(this, sessionId); this.siteApis.set(sessionId, api); }
    const state = this.session(sessionId);
    state.finalized = false;
    const tab = new Tab(page.getActivePage() ?? 'adapter', { rt: this, sessionId, state }, page);
    return { tab, page, sites: api.sites, recon: api.recon };
  }

  isManagedPage(page: RuntimePage): page is ManagedRuntimePage { return typeof (page as ManagedRuntimePage).claim === 'function'; }

  async runSite(site: string, name: string, args: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal; sessionId?: string } = {}): Promise<CommandRunResult | CommandRunError> {
    const cmd = await this.registry.resolve(site, name);
    // a session already using this site's commands needs no suggestion of them
    if (opts.sessionId) this.sessions.get(opts.sessionId)?.suggestedSites.add(cmd.site);
    return this.runCommand(cmd, args, opts);
  }

  private async runCommand(cmd: AdapterCommand, args: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal; sessionId?: string } = {}): Promise<CommandRunResult | CommandRunError> {
    const site = cmd.site;
    const name = cmd.name;
    const active = this.adapterCallContext.getStore();
    if (active?.retired) return { ok: false, site, name, error: { code: 'command_outcome_unknown', message: 'The parent adapter call has timed out or been cancelled', hint: 'Inspect browser or site state before retrying.' }, elapsedMs: 0 };
    // A nested call into the same site is part of the current workflow and already owns its page.
    if (active?.sites.has(site)) return runAdapter(this, cmd, args, opts);
    const sessionId = opts.sessionId ?? active?.sessionId;
    const lockKey = `${sessionId ?? "legacy"}:${site}`;
    const previous = this.adapterRuns.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.adapterRuns.set(lockKey, current);
    await previous;
    try {
      const callContext = { sites: new Set([...(active?.sites ?? []), site]), retired: false, sessionId };
      const result = await this.adapterCallContext.run(callContext, () => runAdapter(this, cmd, args, opts));
      if (!result.ok && result.error.code === 'command_outcome_unknown') {
        callContext.retired = true;
        // Timed-out adapter code may still be running. Retire its page before the next call uses this site.
        const key = sessionId ? `mcp:${sessionId}` : `site:${site}`;
        await this.createPage({ session: key, surface: 'adapter' }).then((p) => p.closeWindow()).catch(() => {});
      }
      return result;
    } finally {
      release();
      if (this.adapterRuns.get(lockKey) === current) this.adapterRuns.delete(lockKey);
    }
  }

  private draftStore(): DraftStore {
    if (!this.drafts) throw Object.assign(new Error('Adapter authoring is disabled by the host'), { code: 'capability_unavailable' });
    return this.drafts;
  }

  listTools(): ReturnType<typeof listDefinedTools> { return this.userAdaptersDir ? listDefinedTools(this.userAdaptersDir) : []; }

  async defineTool(def: ToolDefinition): ReturnType<DraftStore['createDraft']> {
    return this.draftStore().createDraft(def, this.registry.sourceFile(def.site, def.name));
  }
  async tryToolDraft(id: string, args: Record<string, unknown>, expect: DraftExpectation, sessionId?: string): ReturnType<DraftStore['tryDraft']> {
    return this.draftStore().tryDraft((cmd, sample) => this.runCommand(cmd, sample, { sessionId }), id, args, expect);
  }
  async activateToolDraft(id: string): Promise<ReturnType<DraftStore['activateDraft']>> {
    const active = this.draftStore().activateDraft(id, (site, name) => this.registry.sourceFile(site, name));
    await this.registry.load();
    this.emit('tools-changed', { site: active.site });
    return active;
  }
  discardToolDraft(id: string): ReturnType<DraftStore['discardDraft']> { return this.draftStore().discardDraft(id); }
  async removeTool(site: string, name: string): Promise<boolean> {
    this.draftStore();
    const ok = deleteTool(site, name, this.userAdaptersDir!);
    if (ok) { await this.registry.load(); this.emit('tools-changed', { site }); }
    return ok;
  }

  async closeSession(id: string, opts: { finalize?: boolean } = {}): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    await s.js?.dispose();
    this.sessions.delete(id);
    this.siteApis.delete(id);
    const page = s.browserPage;
    if (page && opts.finalize !== false && !s.finalized) {
      try {
        if (this.isManagedPage(page)) await page.finalize([], { closing: true });
        else await page.closeWindow();
      } catch (err) { this.emit('log', `finalize on close failed: ${(err as Error).message}`); }
    }
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.closeSession(id);
    this.unsubscribeBackend?.();
    await this.browserBackend?.dispose();
  }

  doctor(): DoctorReport {
    const list = this.registry.sites();
    return {
      backend: this.backend(),
      browser: { connected: this.browserAvailable(), features: this.features() },
      extension: { connected: Boolean(this.bridge?.connected), protocolMatches: this.backend() === 'electron' ? null : Boolean(this.bridge?.protocolMatches), protocolWarning: this.bridge?.protocolWarning ?? null, version: this.bridge?.extensionVersion ?? null, protocolRevision: this.bridge?.protocolRevision ?? null, hostProtocolRevision: PROTOCOL_REVISION, features: this.features() },
      sites: list.length,
      commands: list.reduce((n, s) => n + s.commands, 0),
      definedTools: this.listTools().length,
      // Count only real MCP sessions; background adapter contexts are keyed `site:<site>` and are not agents.
      sessions: [...this.sessions.keys()].filter((k) => !k.startsWith('site:')).length,
      cursor: this.cursorEnabled,
    };
  }
}
