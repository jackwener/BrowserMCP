import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { Runtime } from '../src/runtime/runtime.js';
import { startIpcServer } from '../src/host/ipc.js';
import { connectHost, type HostState, type HostDiagnostic } from '../src/host/state.js';
import { connectSocket, probeSocket, attachSocket } from '../src/host/socket.js';

describe('Local IPC client sessions', () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of open.splice(0).reverse()) await close().catch(() => {}); });

  it('keeps two MCP clients in separate runtime sessions and cleans up only the departing one', async () => {
    const rt = new Runtime();
    await rt.init();
    open.push(() => rt.shutdown());
    const host = await startIpcServer(rt, { version: 'test', probe: async () => ({ browserId: 'test', extensionResponsive: true }) });
    open.push(() => host.close());
    const connect = async (id: string) => {
      const client = new Client({ name: id, version: '1' }, { capabilities: {} });
      const transport = await connectSocket(host.endpoint);
      await probeSocket(transport);
      expect(rt.sessions.size).toBe(id === 'client-one' ? 0 : 1);
      attachSocket(transport);
      await client.connect(transport);
      open.push(() => client.close());
      await client.callTool({ name: 'doctor', arguments: {} });
      return client;
    };
    const first = await connect('client-one');
    const second = await connect('client-two');
    const js = async (client: Client, code: string) => {
      const result = await client.callTool({ name: 'js', arguments: { code } });
      return JSON.parse((result.content as Array<{text: string}>)[0].text);
    };
    expect(await js(first, 'let count = 1; function next() { return ++count }; next()')).toMatchObject({ ok: true, value: 2 });
    expect(await js(first, 'next()')).toMatchObject({ ok: true, value: 3 });
    expect(await js(second, 'typeof count')).toMatchObject({ ok: true, value: 'undefined' });
    // Cancellation travels over IPC and leaves the other client usable.
    const abort = new AbortController();
    const pending = first.callTool({ name: 'js', arguments: { code: 'await new Promise(() => {})' } }, { signal: abort.signal });
    const cancelled = expect(pending).rejects.toThrow();
    await expect.poll(() => [...rt.sessions.values()].some(s => s.js?.status().state === 'running')).toBe(true);
    abort.abort();
    await cancelled;
    await expect.poll(() => [...rt.sessions.values()].every(s => !s.js || s.js.status().state === 'idle')).toBe(true);
    expect(rt.sessions.size).toBe(2);
    await first.close();
    await expect.poll(() => rt.sessions.size).toBe(1);
    expect(await js(second, 'typeof count')).toMatchObject({ ok: true, value: 'undefined' });
    await second.close();
    await expect.poll(() => rt.sessions.size).toBe(0);
  });
  it('arbitrates duplicate browser hosts without probing sessions or disturbing existing clients', async () => {
    const runtimes: Runtime[] = [], states: HostState[] = [];
    const add = async (browserId: string, healthy = true) => {
      const rt = new Runtime(); await rt.init(); runtimes.push(rt); open.push(() => rt.shutdown());
      const host = await startIpcServer(rt, { version: 'test', probe: async () => ({ browserId, extensionResponsive: healthy }) });
      open.push(() => host.close());
      const state = { ...host, pid: process.pid, browserId, version: 'test' };
      states.push(state); return state;
    };
    for (let i = 0; i < 4; i++) await add('same-browser');
    await add('same-browser', false);
    const diagnostics: HostDiagnostic[] = [];
    const first = await connectHost(undefined, states, diagnostics); open.push(() => first.client.close());
    const expected = states.slice(0, 4).sort((a, b) => b.startedAt - a.startedAt || b.instanceId.localeCompare(a.instanceId))[0];
    expect(first.state.instanceId).toBe(expected.instanceId);
    expect(runtimes.reduce((n, rt) => n + rt.sessions.size, 0)).toBe(1);
    expect(diagnostics.filter(d => d.status === 'extension_unresponsive')).toHaveLength(1);
    const second = await connectHost('same-browser', states); open.push(() => second.client.close());
    expect(second.state.instanceId).toBe(first.state.instanceId);
    expect(runtimes.reduce((n, rt) => n + rt.sessions.size, 0)).toBe(2);
    await add('other-browser');
    await expect(connectHost(undefined, states)).rejects.toMatchObject({ code: 'browser_selection_required' });
    expect(runtimes.reduce((n, rt) => n + rt.sessions.size, 0)).toBe(2);
    const result = await first.client.callTool({ name: 'js', arguments: { code: '21 * 2' } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain('42');
  });

});
