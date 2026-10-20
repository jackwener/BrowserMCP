import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { WebContents } from 'electron';
import { PageRegistry, type EmbeddedPageEvent } from '../src/electron/registry.js';

const scope = { workspaceId: 'workspace', profileId: 'profile' };
function contents(url = 'https://example.com/') {
  const events = new EventEmitter();
  return Object.assign(events, { isDestroyed: () => false, getURL: () => url, getTitle: () => 'Loaded', session: 'profile' }) as unknown as WebContents;
}
function fixture() {
  const events: EmbeddedPageEvent[] = [];
  const registry = new PageRegistry(() => {}, wc => { if ((wc.session as unknown) !== 'profile') throw new Error('wrong profile'); });
  registry.bindSession('mcp:a', scope); registry.bindSession('mcp:b', scope);
  registry.subscribe(event => events.push(event));
  return { registry, events };
}

describe('logical embedded tabs', () => {
  it('lists dormant tabs and preserves identity through loading, release, and reacquisition', async () => {
    const { registry, events } = fixture();
    let loads = 0;
    const id = registry.register({ scope, url: 'https://example.com/', title: 'Restored', load: async () => { loads++; return contents(); } });
    registry.setActive(scope, id);
    const before = registry.list(scope)[0];
    expect(before).toMatchObject({ active: true, title: 'Restored', lifecycle: 'dormant' });
    expect(loads).toBe(0);
    await registry.acquire('mcp:a', id);
    expect(registry.visible('mcp:b')).toHaveLength(0);
    registry.release('mcp:a', id);
    await registry.acquire('mcp:b', id);
    expect(loads).toBe(1);
    expect(registry.list(scope)[0]).toMatchObject({ tabId: before.tabId, handle: id, sessionId: 'b', lifecycle: 'ready' });
    expect(events.filter(e => e.kind === 'tab_released')[0]).toMatchObject({ sessionId: 'a', page: { sessionId: undefined } });
    registry.dispose();
  });

  it('reserves ownership before awaiting load, deduplicates load, and rejects other sessions', async () => {
    const { registry } = fixture();
    let resolve!: (value: WebContents) => void;
    let loads = 0;
    const id = registry.register({ scope, url: 'https://example.com/', load: () => { loads++; return new Promise(r => { resolve = r; }); } });
    const one = registry.acquire('mcp:a', id), two = registry.acquire('mcp:a', id);
    await expect(registry.acquire('mcp:b', id)).rejects.toMatchObject({ code: 'page_unavailable' });
    resolve(contents()); await Promise.all([one, two]);
    expect(loads).toBe(1); registry.dispose();
  });

  it('rolls back failed loads and validates the resolved profile before exposing contents', async () => {
    const { registry } = fixture();
    const bad = contents(); Object.assign(bad, { session: 'other' });
    let result = bad;
    const id = registry.register({ scope, url: 'https://example.com/', load: async () => result });
    await expect(registry.acquire('mcp:a', id)).rejects.toThrow('wrong profile');
    expect(registry.list(scope)[0]).toMatchObject({ sessionId: undefined, lifecycle: 'dormant' });
    result = contents(); await registry.acquire('mcp:b', id); registry.dispose();
  });

  it('cancels loading on revocation and never attaches a late result', async () => {
    const { registry } = fixture();
    let resolve!: (value: WebContents) => void;
    let signal!: AbortSignal;
    const id = registry.register({ scope, url: 'https://example.com/', load: s => { signal = s; return new Promise(r => { resolve = r; }); } });
    const loading = registry.acquire('mcp:a', id);
    await Promise.resolve(); registry.unregister(id);
    await expect(loading).rejects.toMatchObject({ code: 'page_unavailable' });
    expect(signal.aborted).toBe(true);
    const late = contents(); resolve(late); await Promise.resolve();
    expect(late.listenerCount('destroyed')).toBe(0);
    expect(registry.list(scope)).toEqual([]); registry.dispose();
  });

  it('does not let a cancelled lease release a newer claim by the same session', async () => {
    const { registry } = fixture();
    let calls = 0;
    const id = registry.register({ scope, url: 'https://example.com/', load: async () => {
      if (++calls === 1) return new Promise<WebContents>(() => {});
      return contents();
    } });
    const old = registry.acquire('mcp:a', id);
    await Promise.resolve(); registry.release('mcp:a', id);
    const next = registry.acquire('mcp:a', id);
    await expect(old).rejects.toMatchObject({ code: 'page_unavailable' });
    await next;
    expect(registry.list(scope)[0]).toMatchObject({ sessionId: 'a', lifecycle: 'ready' }); registry.dispose();
  });

  it('keeps active scope boundaries and makes observer failures harmless', () => {
    const { registry } = fixture();
    registry.subscribe(() => { throw new Error('host UI failed'); });
    const id = registry.register({ scope, url: '', contents: contents() });
    const other = { ...scope, profileId: 'other' };
    expect(() => registry.setActive(other, id)).toThrow('scope');
    registry.setActive(scope, id); registry.claim('mcp:a', id); registry.claim('mcp:a', id);
    expect(registry.list(scope)[0]).toMatchObject({ active: true, sessionId: 'a' }); registry.dispose();
  });
});
