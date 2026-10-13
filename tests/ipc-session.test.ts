import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { Runtime } from '../src/runtime/runtime.js';
import { startIpcServer } from '../src/host/ipc.js';
import { connectSocket } from '../src/host/socket.js';

describe('Local IPC client sessions', () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of open.splice(0).reverse()) await close().catch(() => {}); });

  it('keeps two MCP clients in separate runtime sessions and cleans up only the departing one', async () => {
    const rt = new Runtime();
    await rt.init();
    open.push(() => rt.shutdown());
    const host = await startIpcServer(rt, { version: 'test' });
    open.push(() => host.close());
    const connect = async (id: string) => {
      const client = new Client({ name: id, version: '1' }, { capabilities: {} });
      const transport = await connectSocket(host.endpoint);
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
});
