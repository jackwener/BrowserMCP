import { describe, expect, it } from 'vitest';
import { Runtime } from '../src/runtime/runtime.js';
import { BUILTIN_ADAPTERS_DIR } from '../src/lib/sources.js';
import type { BrowserEvent } from '../src/protocol.js';
import type { BrowserBackend } from '../src/backends/backend.js';

/** A backend that only relays events the test pushes, like the extension or Electron would. */
async function runtime() {
  let push!: (e: BrowserEvent) => void;
  const backend: BrowserBackend = {
    kind: 'electron', available: true, features: () => [],
    createPage: async () => { throw new Error('no pages in this test'); },
    subscribe: (listener) => { push = listener; return () => {}; },
    dispose: async () => {},
  };
  const rt = new Runtime({ backend, sources: [{ dir: BUILTIN_ADAPTERS_DIR, kind: 'builtin' }] });
  await rt.init();
  const events: BrowserEvent[] = [];
  rt.on('browser-event', (e) => events.push(e));
  return { rt, push: (e: BrowserEvent) => push(e), events };
}

describe('changes reported with each js call', () => {
  it('summarizes what happened in the session since the call started, and only that', async () => {
    const { rt, push } = await runtime();
    const state = rt.session('s1');
    rt.session('other');
    push({ kind: 'tab_created', session: 'mcp:s1', page: 'p1', tabId: 1, url: 'about:blank', origin: 'agent' });
    const from = state.changes.seq;
    push({ kind: 'tab_navigated', session: 'mcp:s1', page: 'p1', tabId: 1, url: 'https://example.com/a' });
    push({ kind: 'tab_navigated', session: 'mcp:s1', page: 'p1', tabId: 1, url: 'https://example.com/b' });
    push({ kind: 'tab_created', session: 'mcp:s1', page: 'p2', tabId: 2, url: 'https://example.com/popup', origin: 'agent' });
    push({ kind: 'tab_navigated', session: 'mcp:s1', page: 'p2', tabId: 2, url: 'https://example.com/popup2' });
    push({ kind: 'tab_closed', session: 'mcp:s1', page: 'p3', tabId: 3 });
    push({ kind: 'tab_created', session: 'mcp:other', page: 'p9', tabId: 9, url: 'https://elsewhere.test/', origin: 'agent' });
    push({ kind: 'dialog', page: 'p1', dialogType: 'confirm', message: 'Leave?' });
    const changes = await rt.changesSince('s1', from);
    expect(changes).toEqual({
      opened: [{ tab: 'p2', url: 'https://example.com/popup2' }],
      navigated: [{ tab: 'p1', url: 'https://example.com/b' }],
      closed: ['p3'],
      dialogs: [{ tab: 'p1', type: 'confirm', message: 'Leave?' }],
    });
    expect(await rt.changesSince('s1', state.changes.seq)).toBeUndefined();
  });

  it('suggests the adapters of a site the session reached, once', async () => {
    const { rt, push } = await runtime();
    const state = rt.session('s1');
    let from = state.changes.seq;
    push({ kind: 'tab_navigated', session: 'mcp:s1', page: 'p1', tabId: 1, url: 'https://www.bilibili.com/video/BV1xx' });
    const first = await rt.changesSince('s1', from);
    expect(first?.sites?.[0]?.site).toBe('bilibili');
    expect(first?.sites?.[0]?.commands.length).toBeGreaterThan(0);
    from = state.changes.seq;
    push({ kind: 'tab_navigated', session: 'mcp:s1', page: 'p1', tabId: 1, url: 'https://search.bilibili.com/all?keyword=x' });
    expect((await rt.changesSince('s1', from))?.sites).toBeUndefined();
    // a site whose commands the session already ran is not suggested
    rt.session('s2').suggestedSites.add('reddit');
    push({ kind: 'tab_navigated', session: 'mcp:s2', page: 'p5', tabId: 5, url: 'https://www.reddit.com/r/x' });
    expect((await rt.changesSince('s2', 0))?.sites).toBeUndefined();
    // a host that only ends with the domain's letters is not that site
    push({ kind: 'tab_navigated', session: 'mcp:s2', page: 'p5', tabId: 5, url: 'https://notbilibili.com/' });
    expect((await rt.changesSince('s2', 0))?.sites).toBeUndefined();
  });

  it('reports page issues once each, and tells the embedding browser when a tab needs the user', async () => {
    const { rt, events } = await runtime();
    rt.session('s1');
    const issue = { code: 'auth_required' as const, source: 'detected' as const, status: 401, url: 'https://example.com/me' };
    rt.recordChange('s1', { kind: 'issue', tab: 'p1', issue });
    rt.recordChange('s1', { kind: 'issue', tab: 'p1', issue });
    expect((await rt.changesSince('s1', 0))?.issues).toEqual([{ tab: 'p1', ...issue }]);
    rt.flagAttention('s1', { id: 'p1' }, { code: 'auth_required', source: 'agent', url: 'https://example.com/login' }, 3);
    rt.clearAttention('s1', 'p1');
    rt.clearAttention('s1', 'p1');
    expect(events.filter((e) => e.kind === 'attention')).toEqual([
      { kind: 'attention', session: 'mcp:s1', page: 'p1', reason: 'auth_required', waiting: true, url: 'https://example.com/login' },
      { kind: 'attention', session: 'mcp:s1', page: 'p1', reason: 'auth_required', waiting: false },
    ]);
  });
});
