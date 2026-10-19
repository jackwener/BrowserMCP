import type { Session, WebContents } from 'electron';
import type { BrowserBackend } from '../backends/backend.js';
import type { PageOptions } from '../backends/managed-page.js';
import type { BrowserEvent, BrowserFeature, Command } from '../protocol.js';
import { createExtensionPage } from '../backends/extension-page.js';
import { ElectronDriver } from './driver.js';
import { ElectronChrome } from './chrome.js';
import { ElectronStreams } from './streams.js';
import { PageRegistry, type PageScope, type RegisteredPage } from './registry.js';
import { ActionError } from '../api/errors.js';

export interface ElectronBackendOptions {
  createPage(scope: PageScope): Promise<WebContents>;
  closePage(contents: WebContents): Promise<void>;
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
      if ('page' in event && event.page && ['tab_closed', 'tab_released'].includes(event.kind)) {
        if ('session' in event && this.selected.get(event.session) === event.page) this.selected.delete(event.session);
        this.drivers.get(event.page)?.dispose(event.kind !== 'tab_closed'); this.drivers.delete(event.page);
      }
      this.streams.browserEvent(event);
      for (const listener of this.listeners) listener(event);
    });
    this.chrome = new ElectronChrome({ registry: this.registry, create: (session, url) => this.newPage(session, url), close: (session, id) => this.closePage(session, id), profile: options.profile,
      ...(options.activatePage && { activate: async (page: RegisteredPage) => {
        await options.activatePage!(page.contents);
        if (page.owner) this.streams.emit(page.owner, 'tabs.onActivated', [{ tabId: page.contents.id, windowId: -1 }]);
      } }),
    });
  }
  bindSession(session: string, scope: PageScope): void {
    if (!this.available) throw new ActionError('service_closed', 'Browser service is closed');
    this.registry.bindSession(session, scope); this.scopes.set(session, scope);
  }
  async closeSession(session: string): Promise<void> {
    if (!this.scopes.has(session)) return;
    const finalized = await this.finalize(session, []);
    if (finalized.failed.length) throw new ActionError('cleanup_failed', JSON.stringify(finalized.failed));
    this.streams.reset(session); this.selected.delete(session);
    this.registry.unbindSession(session); this.scopes.delete(session);
  }
  register(contents: WebContents, scope: PageScope): string {
    if (!this.available) throw new ActionError('service_closed', 'Browser service is closed');
    if (contents.session !== this.options.profile(scope)) throw new ActionError('profile_mismatch', 'webContents belongs to a different Electron session');
    return this.registry.register(contents, scope);
  }
  unregister(page: string): void { this.registry.unregister(page); }
  features(): BrowserFeature[] { return ['chrome-api', 'streams', 'page-evaluate', 'frame-evaluate', 'cdp', 'network', 'frames', 'dialogs', 'viewport']; }
  subscribe(listener: (event: BrowserEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async createPage(options: PageOptions) {
    this.registry.scope(options.session);
    return createExtensionPage({ extensionFeatures: this.features(), send: (action, params = {}) => this.dispatch(action, params) }, options);
  }
  command(action: Command['action'], params: Partial<Command>): Promise<{ data: unknown; page?: string }> { return this.dispatch(action, params); }

  private async newPage(session: string, url = 'about:blank'): Promise<RegisteredPage> {
    if (url !== 'about:blank' && !/^(https?:\/\/|data:text\/html)/i.test(url)) throw new ActionError('invalid_url', 'Only HTTP(S) and data:text/html navigation is supported');
    const scope = this.registry.scope(session);
    const contents = await this.options.createPage(scope);
    if (!this.scopes.has(session)) { await this.options.closePage(contents); throw new ActionError('session_closed', 'Session closed during page creation'); }
    if (contents.session !== this.options.profile(scope)) { await this.options.closePage(contents); throw new ActionError('profile_mismatch', 'Host created a page in the wrong profile'); }
    const id = this.registry.register(contents, scope, session);
    this.selected.set(session, id);
    try { if (url !== 'about:blank') await contents.loadURL(url); }
    catch (error) { await this.closePage(session, id); throw error; }
    return this.registry.get(session, id);
  }
  private closePage(session: string, id: string): Promise<void> {
    const page = this.registry.get(session, id);
    const existing = this.closingPages.get(id);
    if (existing) return existing;
    const closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onDestroyed!: () => void;
      const destroyed = new Promise<void>((resolve, reject) => {
        onDestroyed = resolve;
        page.contents.once('destroyed', onDestroyed);
        timer = setTimeout(() => reject(new ActionError('close_failed', 'The host did not destroy the page within 5 seconds')), 5000);
      });
      // Attach a rejection handler before invoking an asynchronous host callback.
      void destroyed.catch(() => {});
      try {
        this.drivers.get(id)?.dispose();
        this.drivers.delete(id);
        await this.options.closePage(page.contents);
        if (!page.contents.isDestroyed()) await destroyed;
        this.registry.unregister(id, 'tab_closed');
      } finally {
        clearTimeout(timer);
        page.contents.removeListener('destroyed', onDestroyed);
      }
    })().finally(() => this.closingPages.delete(id));
    this.closingPages.set(id, closing);
    return closing;
  }
  private async finalize(session: string, keep: Array<{ page: string; status: 'deliverable' | 'handoff' }>) {
    for (const item of keep) this.registry.get(session, item.page);
    const closed: string[] = [], kept: string[] = [], failed: Array<{ page: string; reason: string }> = [];
    for (const page of this.registry.owned(session)) {
      try {
        const status = keep.find(item => item.page === page.id)?.status;
        if (status === 'handoff') { page.mark = 'handoff'; kept.push(page.id); }
        else if (status === 'deliverable' || page.origin === 'user') { this.registry.release(session, page.id); kept.push(page.id); }
        else { await this.closePage(session, page.id); closed.push(page.id); }
      } catch (error) { failed.push({ page: page.id, reason: String(error) }); }
    }
    this.streams.reset(session);
    return { closed, kept, failed };
  }
  private async target(session: string, page?: string, surface?: string): Promise<RegisteredPage> {
    const id = page ?? this.selected.get(session);
    if (id) return this.registry.get(session, id);
    if (surface === 'adapter') return this.newPage(session);
    throw new ActionError('no_tab', 'Open or claim a page first');
  }
  private driver(page: RegisteredPage): ElectronDriver {
    let driver = this.drivers.get(page.id);
    if (!driver) { driver = new ElectronDriver(page.contents, this.options.pageModuleSource); this.drivers.set(page.id, driver); }
    return driver;
  }
  private async dispatch(action: Command['action'], params: Partial<Command>): Promise<{ data: unknown; page?: string }> {
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
      const query = params.query?.toLowerCase();
      return { data: this.registry.visible(session).filter(page => !page.owner && (!query || `${page.contents.getURL()} ${page.contents.getTitle()}`.toLowerCase().includes(query))).slice(0, params.limit ?? 20).map(page => ({ tabId: page.contents.id, url: page.contents.getURL(), title: page.contents.getTitle(), windowId: -1, active: page.contents.isFocused() })) };
    }
    if (action === 'close-user-tabs') {
      const closed: number[] = [], failed: Array<{ tabId: number; reason: string }> = [];
      for (const tabId of params.tabIds ?? []) {
        try {
          const page = this.registry.visible(session).find(page => page.contents.id === tabId);
          if (!page) throw new ActionError('page_unavailable', 'Tab is not available');
          this.registry.claim(session, page.id);
          await this.closePage(session, page.id); closed.push(tabId);
        } catch (error) { failed.push({ tabId, reason: String(error) }); }
      }
      return { data: { closed, failed, complete: failed.length === 0 } };
    }
    if (action === 'claim') {
      const match = params.claim ?? {};
      const pages = this.registry.visible(session).filter(page => (match.tabId === undefined || page.contents.id === match.tabId) && (!match.active || page.contents.isFocused()) && (!match.url || page.contents.getURL() === match.url) && (!match.title || page.contents.getTitle() === match.title));
      if (pages.length !== 1) throw new ActionError('ambiguous_tab', `Expected one matching tab, found ${pages.length}`);
      const candidate = pages[0];
      if ((match.expectedUrl && candidate.contents.getURL() !== match.expectedUrl) || (match.expectedTitle && candidate.contents.getTitle() !== match.expectedTitle)) throw new ActionError('tab_changed', 'Tab no longer matches the expected identity');
      const page = this.registry.claim(session, candidate.id); this.selected.set(session, page.id);
      return { page: page.id, data: { tabId: page.contents.id, url: page.contents.getURL(), title: page.contents.getTitle() } };
    }
    if (action === 'tabs') {
      if (params.op === 'list') return { data: this.registry.owned(session).map(page => ({ page: page.id, tabId: page.contents.id, url: page.contents.getURL(), title: page.contents.getTitle(), selected: this.selected.get(session) === page.id, active: page.contents.isFocused(), origin: page.origin, state: page.mark === 'handoff' ? 'handoff' : 'active' })) };
      if (params.op === 'new') { const page = await this.newPage(session, params.url); return { page: page.id, data: null }; }
      const page = await this.target(session, params.page);
      if (params.op === 'close') await this.closePage(session, page.id);
      else if (params.op === 'release') this.registry.release(session, page.id);
      else throw new ActionError('invalid_args', 'Unknown tab operation');
      if (this.selected.get(session) === page.id) this.selected.delete(session);
      return { data: null };
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
      return result({ url: page.contents.getURL(), title: page.contents.getTitle(), timedOut: page.contents.isLoadingMainFrame() });
    }
    if (action === 'mark') { page.mark = params.mark ?? undefined; return result(null); }
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
