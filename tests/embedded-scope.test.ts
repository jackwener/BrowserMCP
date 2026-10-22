import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Session, WebContents } from 'electron';
import { ElectronBackend } from '../src/electron/backend.js';
import type { PageScope } from '../src/electron/registry.js';

const home: PageScope = { workspaceId: 'w1', profileId: 'home' };
const work: PageScope = { workspaceId: 'w2', profileId: 'work' };
const sessions = { home: { cookies: {} } as unknown as Session, work: { cookies: {} } as unknown as Session };
function contents(profile: Session, url: string) {
  return Object.assign(new EventEmitter(), { id: Math.random(), isDestroyed: () => false, getURL: () => url, getTitle: () => url, loadURL: async () => {}, session: profile }) as unknown as WebContents;
}
function fixture() {
  const backend = new ElectronBackend({
    profile: scope => sessions[scope.profileId as 'home' | 'work'],
    createPage: async () => { throw new Error('not used'); },
  });
  const page = (scope: PageScope, url: string) => backend.register({ scope, url, title: url, contents: contents(sessions[scope.profileId as 'home' | 'work'], url), close: async () => {} });
  return { backend, page };
}

describe('embedded session scope', () => {
  it('is a no-op for the same scope', async () => {
    const { backend, page } = fixture();
    const x = page(home, 'https://x.com/');
    backend.bindSession('mcp:s', home);
    await backend.registry.acquire('mcp:s', x);
    expect(backend.setScope('mcp:s', { ...home })).toEqual({ changed: false, released: [] });
    expect(backend.registry.owned('mcp:s').map(p => p.id)).toEqual([x]);
  });

  it('releases (never closes) controlled tabs and then sees only the new scope', async () => {
    const { backend, page } = fixture();
    let closed = 0;
    const x = backend.register({ scope: home, url: 'https://x.com/', title: 'X', contents: contents(sessions.home, 'https://x.com/'), close: async () => { closed++; } });
    const cf = page(work, 'https://dash.cloudflare.com/');
    backend.bindSession('mcp:s', home);
    await backend.registry.acquire('mcp:s', x);
    const released: string[] = [];
    backend.registry.subscribe(e => { if (e.kind === 'tab_released') released.push(e.page.handle); });

    expect(backend.setScope('mcp:s', work)).toEqual({ changed: true, released: [x] });
    expect(closed).toBe(0);
    expect(released).toEqual([x]);
    expect(backend.registry.list(home)[0]).toMatchObject({ handle: x, sessionId: undefined });
    expect(backend.registry.visible('mcp:s').map(p => p.id)).toEqual([cf]);
    await backend.registry.acquire('mcp:s', cf);
    expect(backend.registry.owned('mcp:s').map(p => p.id)).toEqual([cf]);
  });

  it('tells a stale handle from the old scope why it stopped working', async () => {
    const { backend, page } = fixture();
    const x = page(home, 'https://x.com/');
    const stranger = page({ workspaceId: 'w3', profileId: 'home' }, 'https://y.com/');
    backend.bindSession('mcp:s', home);
    backend.setScope('mcp:s', work);
    expect(() => backend.registry.claim('mcp:s', x)).toThrow(expect.objectContaining({ code: 'scope_changed' }));
    expect(() => backend.registry.claim('mcp:s', stranger)).toThrow(expect.objectContaining({ code: 'page_unavailable' }));
    backend.setScope('mcp:s', home);
    expect(backend.registry.claim('mcp:s', x).id).toBe(x);
  });

  it('rejects an invalid scope without touching the session', async () => {
    const { backend, page } = fixture();
    const x = page(home, 'https://x.com/');
    backend.bindSession('mcp:s', home);
    await backend.registry.acquire('mcp:s', x);
    expect(() => backend.setScope('mcp:s', { workspaceId: '', profileId: 'work' })).toThrow(expect.objectContaining({ code: 'invalid_scope' }));
    expect(backend.registry.owned('mcp:s').map(p => p.id)).toEqual([x]);
    expect(backend.registry.scope('mcp:s')).toEqual(home);
  });
});
