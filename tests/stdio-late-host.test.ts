import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Runtime } from '../src/runtime/runtime.js';
import { startIpcServer } from '../src/host/ipc.js';

describe('stdio launcher when Chrome starts later', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

  it('keeps tool discovery and the same MCP connection alive until the host appears', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-late-host-'));
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.resolve('src/main.ts'), 'stdio'],
      env: { ...process.env, HOME: home },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'late-host-test', version: '1' }, { capabilities: {} });
    let toolsChanged!: () => void;
    const changed = new Promise<void>((resolve) => { toolsChanged = resolve; });
    client.setNotificationHandler('notifications/tools/list_changed', async () => { toolsChanged(); });
    await client.connect(transport);
    cleanup.push(() => client.close());

    expect(client.getInstructions()).toContain('opencli-mcp');
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('js');
    expect((await client.listResources()).resources.some((resource) => resource.uri.startsWith('opencli://docs/'))).toBe(true);
    const offline = await client.callTool({ name: 'js', arguments: { code: 'await browser.tabs.new("https://example.com")' } });
    expect(offline.isError).toBe(true);
    expect(offline.content).toMatchObject([{ type: 'text', text: expect.stringContaining('host_unavailable') }]);

    const rt = new Runtime();
    await rt.init();
    const host = await startIpcServer(rt, { version: 'test' });
    let activeHost = host;
    cleanup.push(async () => { await activeHost.close(); await rt.shutdown(); });
    const run = path.join(home, '.opencli-mcp', 'run');
    fs.mkdirSync(run, { recursive: true });
    const publish = (instance: typeof host, browserId = 'late-browser') => {
      const file = path.join(run, `${instance.instanceId}.json`);
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, browserId, instanceId: instance.instanceId, endpoint: instance.endpoint, version: 'test' }));
      return file;
    };
    const firstFile = publish(host);

    let timeout!: NodeJS.Timeout;
    try {
      await Promise.race([changed, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('tools/list_changed was not sent')), 5000); })]);
    } finally { clearTimeout(timeout); }
    const online = await client.callTool({ name: 'doctor', arguments: {} });
    expect(online.isError).not.toBe(true);
    expect(online.content).toMatchObject([{ type: 'text', text: expect.stringContaining('"ok":true') }]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('js');
    await client.callTool({ name: 'js', arguments: { code: 'let oldBinding = 42' } });
    await host.close();
    fs.rmSync(firstFile);
    const other = await startIpcServer(rt, { version: 'other' });
    cleanup.push(() => other.close());
    publish(other, 'other-browser');
    const wrongProfile = await client.callTool({ name: 'doctor', arguments: {} });
    expect(wrongProfile.content).toMatchObject([{ type: 'text', text: expect.stringContaining('host_unavailable') }]);
    activeHost = await startIpcServer(rt, { version: 'restarted' });
    publish(activeHost);
    // Discovery may reconnect but must not consume the session-loss notice.
    await client.listTools();
    const restarted = await client.callTool({ name: 'js', arguments: { code: 'let replayed = true' } });
    expect(restarted.content).toMatchObject([{ type: 'text', text: expect.stringContaining('session_restarted') }]);
    const fresh = await client.callTool({ name: 'js', arguments: { code: '[typeof oldBinding, typeof replayed]' } });
    expect(fresh.content).toMatchObject([{ type: 'text', text: expect.stringContaining('["undefined","undefined"]') }]);

  });
});
