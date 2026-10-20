import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { ActionError } from '../api/errors.js';
import type { BrowserEvent } from '../protocol.js';

export interface PageScope { workspaceId: string; profileId: string }
export interface PageRegistration {
  scope: PageScope;
  url: string;
  title?: string;
  contents?: WebContents;
  /** Resolve only after the host's restored page is ready. Honor cancellation when possible. */
  load?: (signal: AbortSignal) => Promise<WebContents>;
  /** Close the logical host tab, including when it has no WebContents. */
  close?: () => Promise<void>;
}
export interface PageSnapshot {
  handle: string;
  tabId: number;
  scope: PageScope;
  url: string;
  title: string;
  active: boolean;
  lifecycle: 'dormant' | 'loading' | 'ready';
  sessionId?: string;
  origin: 'user' | 'agent';
}
export interface EmbeddedPageEvent {
  kind: 'page_registered' | 'page_updated' | 'page_activated' | 'page_unregistered' | 'tab_created' | 'tab_acquired' | 'tab_released' | 'tab_closed' | 'tab_navigated';
  page: PageSnapshot;
  /** Public createSession().id; also present on release/close events. */
  sessionId?: string;
}
export interface RegisteredPage {
  id: string;
  tabId: number;
  contents?: WebContents;
  scope: PageScope;
  url: string;
  title: string;
  active: boolean;
  lifecycle: PageSnapshot['lifecycle'];
  load?: PageRegistration['load'];
  close?: PageRegistration['close'];
  loading?: Promise<ReadyPage>;
  controller?: AbortController;
  owner?: string;
  generation: number;
  closing?: boolean;
  origin: 'user' | 'agent';
  mark?: 'deliverable' | 'handoff';
  cleanup(): void;
}
export type ReadyPage = RegisteredPage & { contents: WebContents };
const sameScope = (a: PageScope, b: PageScope) => a.workspaceId === b.workspaceId && a.profileId === b.profileId;
const publicSession = (id?: string) => id?.replace(/^mcp:/, '');

/** Logical host tabs survive lazy loading; WebContents is an execution resource, not tab identity. */
export class PageRegistry {
  private readonly pages = new Map<string, RegisteredPage>();
  private readonly scopes = new Map<string, PageScope>();
  private readonly listeners = new Set<(event: EmbeddedPageEvent) => void>();
  private nextTabId = 1;
  constructor(private readonly emit: (event: BrowserEvent) => void, private readonly validateContents: (contents: WebContents, scope: PageScope) => void, private readonly log?: (message: string) => void) {}
  private validateScope(scope: PageScope): void {
    if (!scope || typeof scope.workspaceId !== 'string' || !scope.workspaceId.trim() || typeof scope.profileId !== 'string' || !scope.profileId.trim()) throw new ActionError('invalid_scope', 'workspaceId and profileId must be non-empty strings');
  }
  snapshot(page: RegisteredPage): PageSnapshot {
    return { handle: page.id, tabId: page.tabId, scope: { ...page.scope }, url: page.url, title: page.title, active: page.active, lifecycle: page.lifecycle, sessionId: publicSession(page.owner), origin: page.origin };
  }
  list(scope: PageScope): PageSnapshot[] { this.validateScope(scope); return [...this.pages.values()].filter(page => sameScope(page.scope, scope)).map(page => this.snapshot(page)); }
  subscribe(listener: (event: EmbeddedPageEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(kind: EmbeddedPageEvent['kind'], page: RegisteredPage, session = page.owner): void {
    for (const listener of this.listeners) {
      try { listener({ kind, page: this.snapshot(page), sessionId: publicSession(session) }); }
      catch (error) { this.log?.(`Embedded event listener failed: ${String(error)}`); }
    }
  }
  private event(kind: 'tab_created' | 'tab_acquired' | 'tab_closed' | 'tab_released' | 'tab_navigated', page: RegisteredPage, session = page.owner): void {
    if (session) this.emit({ kind, session, page: page.id, tabId: page.tabId, url: page.url, title: page.title, origin: page.origin });
    this.notify(kind, page, session);
  }
  bindSession(id: string, scope: PageScope): void {
    this.validateScope(scope);
    if (this.scopes.has(id)) throw new ActionError('session_exists', 'Session scope is already bound');
    this.scopes.set(id, { ...scope });
  }
  scope(session: string): PageScope {
    const scope = this.scopes.get(session);
    if (!scope) throw new ActionError('session_closed', 'No host authorization exists for this session');
    return scope;
  }
  unbindSession(id: string): void { this.scopes.delete(id); }
  private hostPage(id: string): RegisteredPage {
    const page = this.pages.get(id);
    if (!page) throw new ActionError('page_unavailable', 'Page is no longer registered');
    return page;
  }
  register(input: PageRegistration, owner?: string): string {
    this.validateScope(input.scope);
    if (typeof input.url !== 'string' || (input.title !== undefined && typeof input.title !== 'string')) throw new ActionError('invalid_page', 'Page URL and title must be strings');
    if (!input.contents && !input.load) throw new ActionError('invalid_page', 'A page needs contents or a lazy load callback');
    const page: RegisteredPage = { id: randomUUID(), tabId: this.nextTabId++, scope: { ...input.scope }, url: input.url, title: input.title ?? '', active: false, generation: 0, lifecycle: 'dormant', load: input.load, close: input.close, owner, origin: owner ? 'agent' : 'user', cleanup() {} };
    if (input.contents) this.attach(page, input.contents);
    this.pages.set(page.id, page);
    this.notify('page_registered', page);
    if (owner) this.event('tab_created', page);
    return page.id;
  }
  private attach(page: RegisteredPage, contents: WebContents): void {
    if (contents.isDestroyed()) throw new ActionError('stale_page', 'Cannot attach a destroyed WebContents');
    this.validateContents(contents, page.scope);
    if ([...this.pages.values()].some(other => other !== page && other.contents === contents)) throw new ActionError('page_registered', 'This WebContents is already registered');
    page.cleanup();
    page.contents = contents;
    page.lifecycle = page.load && !contents.getURL() ? 'dormant' : 'ready';
    if (contents.getURL()) { page.url = contents.getURL(); page.title = contents.getTitle(); }
    const onNavigated = () => {
      page.url = contents.getURL(); page.title = contents.getTitle();
      this.event('tab_navigated', page);
    };
    const onTitle = () => { page.title = contents.getTitle(); this.notify('page_updated', page); };
    const onDestroyed = () => {
      if (page.load && !page.closing) {
        if (page.owner) this.release(page.owner, page.id);
        page.cleanup(); page.contents = undefined; page.lifecycle = 'dormant';
        this.notify('page_updated', page);
      } else this.unregister(page.id, 'tab_closed');
    };
    contents.once('destroyed', onDestroyed);
    contents.on('did-navigate', onNavigated);
    contents.on('did-navigate-in-page', onNavigated);
    contents.on('page-title-updated', onTitle);
    page.cleanup = () => {
      contents.removeListener('destroyed', onDestroyed);
      contents.removeListener('did-navigate', onNavigated);
      contents.removeListener('did-navigate-in-page', onNavigated);
      contents.removeListener('page-title-updated', onTitle);
    };
  }
  update(id: string, metadata: { url?: string; title?: string }): void {
    const page = this.hostPage(id);
    if (metadata.url !== undefined) page.url = metadata.url;
    if (metadata.title !== undefined) page.title = metadata.title;
    this.notify('page_updated', page);
  }
  setActive(scope: PageScope, id: string | null): void {
    this.validateScope(scope);
    if (id !== null && !sameScope(this.hostPage(id).scope, scope)) throw new ActionError('invalid_scope', 'Active page must belong to this scope');
    const changed = [...this.pages.values()].filter(page => sameScope(page.scope, scope) && page.active !== (page.id === id));
    for (const page of changed) page.active = page.id === id;
    for (const page of changed) this.notify(page.active ? 'page_activated' : 'page_updated', page);
  }
  unregister(id: string, kind: 'tab_closed' | 'tab_released' = 'tab_released'): void {
    const page = this.pages.get(id);
    if (!page) return;
    page.controller?.abort(); page.cleanup(); this.pages.delete(id);
    const owner = page.owner; page.owner = undefined;
    this.event(kind, page, owner); this.notify('page_unregistered', page, owner);
  }
  visible(session: string): RegisteredPage[] {
    const scope = this.scope(session);
    return [...this.pages.values()].filter(page => sameScope(page.scope, scope) && (!page.owner || page.owner === session));
  }
  owned(session: string): RegisteredPage[] { return this.visible(session).filter(page => page.owner === session); }
  get(session: string, id: string): RegisteredPage {
    const page = this.visible(session).find(page => page.id === id && page.owner === session);
    if (!page) throw new ActionError('page_unavailable', 'Page was closed, released, or is not owned by this session');
    return page;
  }
  claim(session: string, id: string): RegisteredPage {
    const page = this.visible(session).find(page => page.id === id);
    if (!page) throw new ActionError('page_unavailable', 'Page is not available to this session');
    if (page.owner !== session) { page.generation++; page.owner = session; this.event('tab_acquired', page); }
    return page;
  }
  async ready(session: string, id: string): Promise<ReadyPage> {
    const page = this.get(session, id);
    const generation = page.generation;
    if (page.lifecycle === 'ready' && page.contents && !page.contents.isDestroyed()) return page as ReadyPage;
    if (!page.load) throw new ActionError('page_not_ready', 'Host must provide a load callback for a dormant page');
    if (!page.loading) {
      const controller = new AbortController(); page.controller = controller; page.lifecycle = 'loading';
      this.notify('page_updated', page);
      page.loading = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort!: () => void;
        try {
          const cancelled = new Promise<never>((_, reject) => {
            onAbort = () => reject(new ActionError('page_unavailable', 'Page loading was cancelled'));
            controller.signal.addEventListener('abort', onAbort, { once: true });
            if (controller.signal.aborted) onAbort();
            timer = setTimeout(() => controller.abort(), 30000);
          });
          const contents = await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return page.load!(controller.signal); }), cancelled]);
          if (controller.signal.aborted || this.pages.get(id) !== page || page.owner !== session || page.generation !== generation) throw new ActionError('page_unavailable', 'Page access was revoked during loading');
          this.get(session, id);
          if (!contents.getURL()) throw new ActionError('page_not_ready', 'Host load() must resolve after the page has loaded');
          this.attach(page, contents); page.lifecycle = 'ready';
          this.notify('page_updated', page);
          return page as ReadyPage;
        } catch (error) {
          if (this.pages.get(id) === page && page.controller === controller) { page.lifecycle = 'dormant'; this.notify('page_updated', page); }
          throw error;
        } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); if (page.controller === controller) { page.loading = undefined; page.controller = undefined; } }
      })();
    }
    await page.loading;
    if (page.generation !== generation) throw new ActionError('page_unavailable', 'Ownership changed during loading');
    return this.get(session, id) as ReadyPage;
  }
  async acquire(session: string, id: string): Promise<ReadyPage> {
    const candidate = this.visible(session).find(page => page.id === id);
    const previousOwner = candidate?.owner;
    const page = this.claim(session, id);
    const generation = page.generation;
    try { return await this.ready(session, id); }
    catch (error) {
      if (!previousOwner && this.pages.get(id) === page && page.owner === session && page.generation === generation) this.release(session, id);
      throw error;
    }
  }
  release(session: string, id: string): void {
    const page = this.get(session, id);
    page.generation++; page.controller?.abort(); page.controller = undefined; page.loading = undefined;
    if (page.lifecycle === 'loading') page.lifecycle = 'dormant';
    page.owner = undefined; page.origin = 'user'; page.mark = undefined;
    this.event('tab_released', page, session);
  }
  dispose(): void { for (const page of this.pages.values()) { page.controller?.abort(); page.cleanup(); } this.pages.clear(); this.scopes.clear(); this.listeners.clear(); }
}
