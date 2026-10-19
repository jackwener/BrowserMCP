import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { ActionError } from '../api/errors.js';
import type { BrowserEvent } from '../protocol.js';

export interface PageScope { workspaceId: string; profileId: string }
export interface RegisteredPage {
  id: string;
  contents: WebContents;
  scope: PageScope;
  owner?: string;
  origin: 'user' | 'agent';
  mark?: 'deliverable' | 'handoff';
  cleanup(): void;
}

/** Explicit registrations only: never enumerates the application's webContents. */
export class PageRegistry {
  private readonly pages = new Map<string, RegisteredPage>();
  private readonly scopes = new Map<string, PageScope>();
  constructor(private readonly emit: (event: BrowserEvent) => void) {}

  bindSession(id: string, scope: PageScope): void {
    if (!scope || typeof scope.workspaceId !== 'string' || !scope.workspaceId.trim() || typeof scope.profileId !== 'string' || !scope.profileId.trim()) throw new ActionError('invalid_scope', 'workspaceId and profileId must be non-empty strings');
    if (this.scopes.has(id)) throw new ActionError('session_exists', 'Session scope is already bound');
    this.scopes.set(id, { ...scope });
  }
  scope(session: string): PageScope {
    const scope = this.scopes.get(session);
    if (!scope) throw new ActionError('session_closed', 'No host authorization exists for this session');
    return scope;
  }
  unbindSession(id: string): void { this.scopes.delete(id); }

  register(contents: WebContents, scope: PageScope, owner?: string): string {
    if (contents.isDestroyed()) throw new ActionError('stale_page', 'Cannot register a destroyed page');
    if ([...this.pages.values()].some(page => page.contents === contents)) throw new ActionError('page_registered', 'This webContents is already registered');
    const id = randomUUID();
    const onDestroyed = () => this.unregister(id, 'tab_closed');
    const onNavigated = () => { if (page.owner) this.emit({ kind: 'tab_navigated', session: page.owner, page: id, tabId: contents.id, url: contents.getURL() }); };
    const page: RegisteredPage = { id, contents, scope: { ...scope }, owner, origin: owner ? 'agent' : 'user', cleanup: () => {
      contents.removeListener('destroyed', onDestroyed);
      contents.removeListener('did-navigate', onNavigated);
      contents.removeListener('did-navigate-in-page', onNavigated);
    } };
    this.pages.set(id, page);
    contents.once('destroyed', onDestroyed);
    contents.on('did-navigate', onNavigated);
    contents.on('did-navigate-in-page', onNavigated);
    if (owner) this.emit({ kind: 'tab_created', session: owner, page: id, tabId: contents.id, origin: 'agent' });
    return id;
  }

  unregister(id: string, kind: 'tab_closed' | 'tab_released' = 'tab_released'): void {
    const page = this.pages.get(id);
    if (!page) return;
    page.cleanup();
    this.pages.delete(id);
    if (page.owner) this.emit({ kind, session: page.owner, page: id, tabId: page.contents.id });
  }
  visible(session: string): RegisteredPage[] {
    const scope = this.scope(session);
    return [...this.pages.values()].filter(page => !page.contents.isDestroyed() && page.scope.workspaceId === scope.workspaceId && page.scope.profileId === scope.profileId && (!page.owner || page.owner === session));
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
    page.owner = session;
    this.emit({ kind: 'tab_acquired', session, page: id, tabId: page.contents.id, origin: page.origin });
    return page;
  }
  release(session: string, id: string): void {
    const page = this.get(session, id);
    page.owner = undefined;
    page.origin = 'user';
    page.mark = undefined;
    this.emit({ kind: 'tab_released', session, page: id, tabId: page.contents.id });
  }
  dispose(): void { for (const page of this.pages.values()) page.cleanup(); this.pages.clear(); this.scopes.clear(); }
}
