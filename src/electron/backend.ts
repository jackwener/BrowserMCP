import { discoverTabs } from '../shared/api-contract.js';
import type { Session, WebContents } from 'electron';
import type { BrowserBackend } from '../backends/backend.js';
import type { PageOptions } from '../backends/managed-page.js';
import type { BrowserEvent, BrowserFeature, Command } from '../protocol.js';
import { createExtensionPage } from '../backends/extension-page.js';
import { ElectronDriver } from './driver.js';
import { ElectronChrome } from './chrome.js';
import { ElectronStreams } from './streams.js';
import { PageRegistry, hostFailure, type PageScope, type RegisteredPage, type ReadyPage, type PageRegistration } from './registry.js';
import { ActionError } from '../api/errors.js';

export interface ElectronBackendOptions {
  createPage(scope: PageScope): Promise<Omit<PageRegistration, 'scope' | 'url'> & { contents: WebContents }>;
  profile(scope: PageScope): Session;
  activatePage?(contents: WebContents): Promise<void>;
  pageModuleSource?: string;
}

/** Lives in Electron main; the host supplies registered pages and MCP transports. */
export class ElectronBackend implements BrowserBackend {
  readonly kind = 'electron' as const;
  available = true;
  readonly registry: PageRegistry;
  readonly streams = new ElectronStreams();
  private readonly chrome: ElectronChrome;
  private readonly listeners = new Set<(event: BrowserEvent) => void>();
  private readonly drivers = new Map<string, ElectronDriver>();
  private readonly closingPages = new Map<string, Promise<void>>();
  private readonly selected = new Map<string, string>();
  private readonly scopes = new Map<string, PageScope>();

  constructor(private readonly options: ElectronBackendOptions) {
    this.registry = new PageRegistry(event => {
      if ('page' in event && event.page && ['tab_closed', 'tab_released', 'tab_detached', 'tab_attached'].includes(event.kind)) {
        if (['tab_closed', 'tab_released'].includes(event.kind) && 'session' in event && this.selected.get(event.session) === event.page) this.selected.delete(event.session);
        this.drivers.get(event.page)?.dispose(event.kind !== 'tab_closed'); this.drivers.delete(event.page);
      }
      this.streams.browserEvent(event);
      for (const listener of this.listeners) listener(event);
    }, (contents, scope) => {
      if (contents.session !== this.options.profile(scope)) throw new ActionError('profile_mismatch', 'WebContents belongs to a different Electron session');
    });
    this.registry.subscribe(event => {
      if (event.kind === 'page_activated' && event.sessionId) this.streams.emit(`mcp:${event.sessionId}`, 'tabs.onActivated', [{ tabId: event.page.tabId, windowId: -1 }]);
    });
    this.chrome = new ElectronChrome({ registry: this.registry, create: (session, url) => this.newPage(session, url), close: (session, id) => this.closeAccessiblePage(session, id), profile: options.profile,
      ...(options.activatePage && { activate: async (page: RegisteredPage) => {
        await this.hostCall('activate', () => options.activatePage!((page as ReadyPage).contents));
        this.registry.setActive(page.scope, page.id);
      } }),
    });
  }
  bindSession(session: string, scope: PageScope): void {
    if (!this.available) throw new ActionError('service_closed', 'Browser service is closed');
    this.registry.bindSession(session, scope); this.scopes.set(session, scope);
  }
  async closeSession(session: string): Promise<void> {
    if (!this.scopes.has(session)) return;
    const finalized = await this.finalize(session, [], true);
    if (finalized.failed.length) throw new ActionError('cleanup_failed', JSON.stringify(finalized.failed));
    this.streams.reset(session); this.selected.delete(session);
    this.registry.unbindSession(session); this.scopes.delete(session);
  }
  register(registration: PageRegistration): string {
    if (!this.available) throw new ActionError('service_closed', 'Browser service is closed');
    return this.registry.register(registration);
  }
  unregister(page: string): void { this.registry.unregister(page); }
  features(): BrowserFeature[] { return ['chrome-api', 'streams', 'page-evaluate', 'frame-evaluate', 'cdp', 'network', 'frames', 'dialogs', 'viewport']; }
  subscribe(listener: (event: BrowserEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async createPage(options: PageOptions) {
    this.registry.scope(options.session);
    return createExtensionPage({ extensionFeatures: this.features(), send: (action, params = {}) => this.dispatch(action, params) }, options);
  }
  command(action: Command['action'], params: Partial<Command>): Promise<{ data: unknown; page?: string }> { return this.dispatch(action, params); }

  private async hostCall<T>(phase: string, callback: () => Promise<T>): Promise<T> {
    try { return await callback(); } catch (error) { throw hostFailure(error, phase); }
  }
  private async newPage(session: string, url = 'about:blank'): Promise<ReadyPage> {
    if (url !== 'about:blank' && !/^(https?:\/\/|data:text\/html)/i.test(url)) throw new ActionError('invalid_url', 'Only HTTP(S) and data:text/html navigation is supported');
    const scope = this.registry.scope(session);
    const created = await this.hostCall('create', () => this.options.createPage({ ...scope }));
    if (!created || typeof created.close !== 'function') throw new ActionError('host_contract_violation', 'createPage must return { contents, close, load? }', 'close() must close the logical host tab even after its WebContents changes.');
    const contents = created.contents;
    try {
      this.registry.checkContents(contents, scope);
      if (!this.scopes.has(session)) throw new ActionError('session_closed', 'Session closed during page creation');
    } catch (error) {
      try { await created.close(); } catch (cleanup) { throw hostFailure(error, 'create', { cleanupError: String(cleanup) }); }
      throw error;
    }
    const id = this.registry.register({ ...created, scope, url: contents.getURL(), title: contents.getTitle() }, session);
    this.selected.set(session, id);
    try { await this.hostCall('navigate', () => contents.loadURL(url)); }
    catch (error) {
      try { if (this.registry.owned(session).some(page => page.id === id)) await this.closePage(session, id); }
      catch (cleanup) { throw hostFailure(error, 'navigate', { cleanupError: String(cleanup) }); }
      throw error;
    }
    return this.registry.ready(session, id);
  }
  private async closeAccessiblePage(session: string, id: string): Promise<void> {
    const previousOwner = this.registry.visible(session).find(page => page.id === id)?.owner;
    const page = this.registry.claim(session, id);
    const generation = page.generation;
    try { await this.closePage(session, id); }
    catch (error) {
      if (!previousOwner && this.registry.visible(session).includes(page) && page.owner === session && page.generation === generation) this.registry.release(session, id);
      throw error;
    }
  }
  private closePage(session: string, id: string): Promise<void> {
    const page = this.registry.get(session, id);
    const existing = this.closingPages.get(id);
    if (existing) return existing;
    page.closing = true;
    const closing = (async () => {
      await this.hostCall('close', () => page.close());
      this.registry.unregister(id, 'tab_closed');
    })().finally(() => { page.closing = false; this.closingPages.delete(id); });
    this.closingPages.set(id, closing);
    return closing;
  }
  private async finalize(session: string, keep: Array<{ page: string; status: 'deliverable' | 'handoff' }>, closing = false) {
    for (const item of keep) this.registry.get(session, item.page);
    const closed: string[] = [], kept: string[] = [], failed: Array<{ page: string; reason: string }> = [];
    for (const page of this.registry.owned(session)) {
      try {
        const status = keep.find(item => item.page === page.id)?.status ?? page.mark;
        if (status === 'handoff' && !closing) { page.mark = 'handoff'; kept.push(page.id); }
        else if (status === 'deliverable' || status === 'handoff' || page.origin === 'user') { this.registry.release(session, page.id); kept.push(page.id); }
        else { await this.closePage(session, page.id); closed.push(page.id); }
      } catch (error) { failed.push({ page: page.id, reason: String(error) }); }
    }
    this.streams.reset(session);
    return { closed, kept, failed };
  }
  private async target(session: string, page?: string, surface?: string): Promise<ReadyPage> {
    const id = page ?? this.selected.get(session);
    if (id) return this.registry.ready(session, id);
    if (surface === 'adapter') return this.newPage(session);
    throw new ActionError('no_tab', 'Open or claim a page first');
  }
  private driver(page: ReadyPage): ElectronDriver {
    let driver = this.drivers.get(page.id);
    if (!driver) { driver = new ElectronDriver(page.contents, this.options.pageModuleSource); this.drivers.set(page.id, driver); }
    return driver;
  }
  private async dispatch(action: Command['action'], params: Partial<Command>): Promise<{ data: unknown; page?: string }> {
    try { return await this.execute(action, params); }
    catch (error) {
      let tabs: unknown;
      try { tabs = this.registry.visible(params.session ?? '').map(page => this.registry.snapshot(page)); } catch { /* Session is already closed. */ }
      throw hostFailure(error, action, { operation: action, ...(params.page && { tab: params.page }), ...(tabs !== undefined ? { tabs } : {}) });
    }
  }
  private async execute(action: Command['action'], params: Partial<Command>): Promise<{ data: unknown; page?: string }> {
    if (!this.available) throw new ActionError('service_closed', 'Browser service is closed');
    const session = params.session ?? '';
    this.registry.scope(session);
    if (action === 'chrome-describe') return { data: this.chrome.describe(params.chromeMethod ?? '') };
    if (action === 'chrome-call') return { data: await this.chrome.call(session, params.chromeMethod ?? '', params.chromeArgs) };
    if (action === 'stream-watch') {
      if (params.streamSource !== 'chrome') throw new ActionError('capability_unavailable', 'Only Chrome event subscriptions are currently provided');
      return { data: this.streams.watch(session, params.eventName ?? '', params.streamOptions?.capacity) };
    }
    if (action === 'stream-read') return { data: this.streams.read(session, params.streamId ?? '', params.streamRead) };
    if (action === 'stream-close') { this.streams.close(session, params.streamId ?? ''); return { data: null }; }
    if (action === 'streams-reset') { this.streams.reset(session); return { data: null }; }
    if (action === 'session-name') return { data: null };
    if (action === 'session-finalize') return { data: await this.finalize(session, params.keep ?? []) };
    if (action === 'cookies') return { data: await this.options.profile(this.registry.scope(session)).cookies.get({ ...(params.url && { url: params.url }), ...(params.domain && { domain: params.domain }) }) };
    if (action === 'user-tabs') {
      return { data: discoverTabs(this.registry.visible(session).map(page => ({
        supported: true, owned: Boolean(page.owner),
        tab: { tabId: page.tabId, url: page.url, title: page.title, windowId: -1, active: page.active, lifecycle: page.lifecycle,
          availability: page.lifecycle === 'ready' ? 'ready' as const : page.load ? 'load_required' as const : 'host_attachment_required' as const },
      })), { query: params.query, limit: params.limit, offset: params.offset }) };
    }
    if (action === 'close-user-tabs') {
      const closed: number[] = [], failed: Array<{ tabId: number; reason: string }> = [];
      for (const tabId of params.tabIds ?? []) {
        try {
          const page = this.registry.visible(session).find(page => page.tabId === tabId);
          if (!page) throw new ActionError('page_unavailable', 'Tab is not available');
          await this.closeAccessiblePage(session, page.id); closed.push(tabId);
        } catch (error) { failed.push({ tabId, reason: String(error) }); }
      }
      return { data: { closed, failed, complete: failed.length === 0 } };
    }
    if (action === 'claim') {
      const match = params.claim ?? {};
      const pages = this.registry.visible(session).filter(page => (match.tabId === undefined || page.tabId === match.tabId) && (!match.active || page.active) && (!match.url || page.url === match.url) && (!match.title || page.title === match.title));
      if (pages.length !== 1) throw new ActionError(pages.length ? 'ambiguous_tab' : 'tab_not_found', `Expected one matching tab, found ${pages.length}`);
      const candidate = pages[0];
      if ((match.expectedUrl && candidate.url !== match.expectedUrl) || (match.expectedTitle && candidate.title !== match.expectedTitle)) throw new ActionError('tab_changed', 'Tab no longer matches the expected identity');
      const page = await this.registry.acquire(session, candidate.id); this.selected.set(session, page.id);
      return { page: page.id, data: { tabId: page.tabId, url: page.url, title: page.title } };
    }
    if (action === 'tabs') {
      if (params.op === 'list') return { data: this.registry.owned(session).map(page => ({ page: page.id, tabId: page.tabId, url: page.url, title: page.title, selected: this.selected.get(session) === page.id, active: page.active, lifecycle: page.lifecycle, origin: page.origin, state: page.mark === 'handoff' ? 'handoff' : 'active' })) };
      if (params.op === 'new') { const page = await this.newPage(session, params.url); return { page: page.id, data: null }; }
      const id = params.page ?? this.selected.get(session);
      if (!id) throw new ActionError('no_tab', 'Open or claim a page first');
      const page = this.registry.get(session, id);
      if (params.op === 'close') await this.closePage(session, page.id);
      else if (params.op === 'release') this.registry.release(session, page.id);
      else throw new ActionError('invalid_args', 'Unknown tab operation');
      if (this.selected.get(session) === page.id) this.selected.delete(session);
      return { data: null };
    }
    if (action === 'mark') {
      if (!params.page) throw new ActionError('invalid_tab_id', 'A tab handle is required');
      this.registry.mark(session, params.page, params.mark ?? null);
      return { page: params.page, data: null };
    }
    const page = await this.target(session, params.page, params.surface);
    const driver = this.driver(page);
    const result = (data: unknown) => ({ page: page.id, data });
    if (action === 'navigate') { await page.contents.loadURL(params.url!); return result(null); }
    if (action === 'exec') {
      if (params.world === 'engine') { const route = await driver.route(params.frame); return result(await driver.evaluate(params.code!, await driver.engineContext(route.frameId), route.frameId, params.timeoutMs)); }
      return result(await driver.evaluateMain(params.code!, params.frame, params.timeoutMs));
    }
    if (action === 'act') return result(await driver.act(params.act!));
    if (action === 'cdp') {
      const method = params.cdpMethod ?? '';
      if (/^(Target|Browser)\./.test(method)) throw new ActionError('capability_unavailable', 'Browser-wide CDP commands are outside this page authorization');
      await driver.ready(); return result(await driver.send(method, params.cdpParams));
    }
    if (action === 'screenshot') {
      await driver.ready();
      let clip: Record<string, number> | undefined;
      if (params.fullPage) {
        const metrics = await driver.send('Page.getLayoutMetrics');
        const size = metrics.cssContentSize ?? metrics.contentSize;
        clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
      }
      const shot = await driver.send('Page.captureScreenshot', { format: params.format ?? 'png', ...(params.quality !== undefined && { quality: params.quality }), ...(clip && { clip }), captureBeyondViewport: Boolean(params.fullPage) });
      return result(shot.data);
    }
    if (action === 'dialog') { await driver.ready(); if (params.dialogOp !== 'get') await driver.send('Page.handleJavaScriptDialog', { accept: params.dialogOp === 'accept', promptText: params.text }); return result({ dialog: driver.dialogInfo }); }
    if (action === 'history') {
      if (params.historyOp === 'reload') page.contents.reload();
      else if (params.historyOp === 'back') page.contents.navigationHistory.goBack();
      else page.contents.navigationHistory.goForward();
      const deadline = Date.now() + (params.timeoutMs ?? 20000);
      while (page.contents.isLoadingMainFrame() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      return result({ url: page.url, title: page.title, timedOut: page.contents.isLoadingMainFrame() });
    }
    if (action === 'frames') return result(await driver.frames());
    if (action === 'network-capture-start') { await driver.startCapture(params.pattern); return result(true); }
    if (action === 'network-capture-read') return result(await driver.readCapture());
    throw new ActionError('capability_unavailable', `Electron backend does not provide ${action}`);
  }
  async dispose(): Promise<void> {
    if (!this.available) return;
    for (const session of [...this.scopes.keys()]) await this.closeSession(session);
    this.available = false;
    for (const driver of this.drivers.values()) driver.dispose();
    this.drivers.clear(); this.registry.dispose(); this.streams.dispose(); this.listeners.clear();
  }
}
