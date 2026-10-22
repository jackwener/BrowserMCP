import { describe, expect, it } from 'vitest';
import { ElectronStreams } from '../src/electron/streams.js';

describe('embedded Chrome event subscriptions', () => {
  it('routes events to the owning session, reports loss, and revokes subscriptions', () => {
    const streams = new ElectronStreams();
    const first = streams.watch('first', 'tabs.onCreated', 1);
    const second = streams.watch('second', 'tabs.onCreated');
    streams.browserEvent({ kind: 'tab_created', session: 'first', tabId: 1 });
    streams.browserEvent({ kind: 'tab_created', session: 'first', tabId: 2 });
    expect(streams.read('first', first.id)).toMatchObject({ dropped: 1, entries: [{ args: [{ id: 2 }] }] });
    expect(streams.read('second', second.id).entries).toEqual([]);
    expect(() => streams.read('second', first.id)).toThrow();
    streams.reset('first');
    expect(() => streams.read('first', first.id)).toThrow();
    expect(streams.read('second', second.id).entries).toEqual([]);
    expect(() => streams.watch('second', 'webRequest.onBeforeRequest')).toThrow();
    streams.dispose();
  });
});
