import type { Session } from 'electron';
import type { PageRegistry, PageScope, RegisteredPage } from './registry.js';
import { ActionError } from '../api/errors.js';

export interface ChromeHost {
  registry: PageRegistry;
  create(session: string, url?: string): Promise<RegisteredPage>;
  close(session: string, page: string): Promise<void>;
  profile(scope: PageScope): Session;
  activate?(page: RegisteredPage): Promise<void>;
}

const methods: Record<string, { args: string[]; description: string }> = {
  'tabs.query': { args: ['queryInfo?'], description: 'Registered tabs visible to this workspace/profile/session only. Supports active, title, and URL patterns.' },
  'tabs.get': { args: ['tabId'], description: 'Get a registered visible tab.' },
  'tabs.create': { args: ['createProperties'], description: 'Ask the host to create an agent-owned tab in this profile.' },
  'tabs.update': { args: ['tabId', 'updateProperties'], description: 'Navigate or activate a registered tab; claims it for this session.' },
  'tabs.remove': { args: ['tabIdOrIds'], description: 'Close registered tabs after checking access for every target.' },
  'tabs.reload': { args: ['tabId'], description: 'Reload a registered tab owned or claimed by this session.' },
  'cookies.getAll': { args: ['details?'], description: 'Read cookies in the host-provided Electron session only.' },
  'cookies.get': { args: ['details'], description: 'Read a named cookie for a URL in this profile.' },
  'cookies.set': { args: ['details'], description: 'Write a cookie in this profile using Electron cookies semantics.' },
  'cookies.remove': { args: ['details'], description: 'Remove a named cookie for a URL in this profile.' },
};

function object(value: unknown): Record<string, any> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ActionError('invalid_args', 'Expected an argument object');
  return value as Record<string, any>;
}
function only(value: Record<string, any>, keys: string[]): void {
  const unsupported = Object.keys(value).filter(key => !keys.includes(key));
  if (unsupported.length) throw new ActionError('capability_unavailable', `Unsupported Electron Chrome API options: ${unsupported.join(', ')}`);
}
function urlPattern(pattern: string, url: string): boolean {
  if (pattern === '<all_urls>') return /^(https?|file|ftp):/.test(url);
  return new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(url);
}

/** Chrome-shaped API with explicit Electron semantics; unsupported methods never fake success. */
export class ElectronChrome {
  constructor(private readonly host: ChromeHost) {}
  describe(member: string) {
    return { member, available: Object.hasOwn(methods, member), backend: 'electron', ...(methods[member] ?? { description: 'Not implemented by this Electron host.' }) };
  }
  private tab(session: string, id: unknown): RegisteredPage {
    if (!Number.isSafeInteger(id)) throw new ActionError('invalid_args', 'A numeric tabId is required');
    const page = this.host.registry.visible(session).find(page => page.contents.id === id);
    if (!page) throw new ActionError('page_unavailable', 'Tab is not registered or accessible to this session');
    return page;
  }
  private snapshot(page: RegisteredPage) {
    return { id: page.contents.id, url: page.contents.getURL(), title: page.contents.getTitle(), active: page.contents.isFocused(), status: page.contents.isLoading() ? 'loading' : 'complete', windowId: -1 };
  }
  async call(session: string, method: string, args: unknown[] = []): Promise<unknown> {
    this.host.registry.scope(session);
    if (!Object.hasOwn(methods, method)) throw new ActionError('capability_unavailable', `Chrome API ${method} is not implemented by this Electron host`, 'Use browser.chrome.describe(method) to inspect availability.');
    if (!Array.isArray(args) || args.length > methods[method].args.length) throw new ActionError('invalid_args', 'Invalid positional arguments');
    if (method === 'tabs.query') {
      const query = object(args[0]); only(query, ['active', 'title', 'url']);
      const urls = query.url === undefined ? [] : Array.isArray(query.url) ? query.url : [query.url];
      if (urls.some((url: unknown) => typeof url !== 'string')) throw new ActionError('invalid_args', 'URL patterns must be strings');
      return this.host.registry.visible(session).map(page => this.snapshot(page)).filter(tab =>
        (query.active === undefined || tab.active === query.active) &&
        (query.title === undefined || urlPattern(query.title, tab.title)) &&
        (!urls.length || urls.some((url: string) => urlPattern(url, tab.url))));
    }
    if (method === 'tabs.create') {
      const props = object(args[0]); only(props, ['url', 'active']);
      if (props.active && !this.host.activate) throw new ActionError('capability_unavailable', 'The host does not provide tab activation');
      const page = await this.host.create(session, props.url);
      if (props.active) await this.host.activate!(page);
      return this.snapshot(page);
    }
    if (method === 'tabs.remove') {
      const ids = Array.isArray(args[0]) ? args[0] : [args[0]];
      const pages = ids.map(id => this.tab(session, id));
      for (const page of pages) this.host.registry.claim(session, page.id);
      for (const page of pages) await this.host.close(session, page.id);
      return undefined;
    }
    if (method.startsWith('tabs.')) {
      const page = this.tab(session, args[0]);
      if (method === 'tabs.get') return this.snapshot(page);
      const props = object(args[1]); only(props, ['url', 'active']);
      if (props.active && !this.host.activate) throw new ActionError('capability_unavailable', 'The host does not provide tab activation');
      if (props.url !== undefined && (typeof props.url !== 'string' || !/^https?:\/\//i.test(props.url))) throw new ActionError('invalid_url', 'Only HTTP(S) navigation is supported');
      this.host.registry.claim(session, page.id);
      if (method === 'tabs.reload') { page.contents.reload(); return undefined; }
      if (props.url !== undefined) await page.contents.loadURL(props.url);
      if (props.active) await this.host.activate!(page);
      return this.snapshot(page);
    }
    const details = object(args[0]);
    const cookies = this.host.profile(this.host.registry.scope(session)).cookies;
    if (method === 'cookies.getAll') {
      only(details, ['url', 'name', 'domain', 'path', 'secure', 'session']);
      return cookies.get(details);
    }
    if (method === 'cookies.set') {
      only(details, ['url', 'name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'expirationDate', 'sameSite']);
      if (typeof details.url !== 'string') throw new ActionError('invalid_args', 'cookies.set requires url');
      const sameSite = { no_restriction: 'no_restriction', lax: 'lax', strict: 'strict', unspecified: 'unspecified' }[details.sameSite as string];
      if (details.sameSite !== undefined && !sameSite) throw new ActionError('invalid_args', 'Unsupported sameSite value');
      await cookies.set(details as Electron.CookiesSetDetails);
      return (await cookies.get({ url: details.url, name: details.name }))[0] ?? null;
    }
    only(details, ['url', 'name']);
    if (typeof details.url !== 'string' || typeof details.name !== 'string') throw new ActionError('invalid_args', 'Cookie URL and name are required');
    const cookie = (await cookies.get(details))[0];
    if (method === 'cookies.get') return cookie ?? null;
    if (!cookie) return null;
    await cookies.remove(details.url, details.name);
    return { url: details.url, name: details.name };
  }
}
