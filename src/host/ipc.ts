/** One persistent MCP server/session per local socket. Chrome owns the shared runtime. */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Runtime } from '../runtime/runtime.js';
import { createMcpServer } from '../mcp/server.js';
import { SocketTransport, removeIpcEndpoint, readControl } from './socket.js';

export interface IpcServerHandle { endpoint: string; instanceId: string; startedAt: number; close(): Promise<void> }

export async function startIpcServer(rt: Runtime, opts: { version: string; probe: () => Promise<{ browserId: string; extensionResponsive: boolean }> }): Promise<IpcServerHandle> {
  const instanceId = randomUUID();
  const startedAt = Date.now();
  const dir = process.platform === 'win32' ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-ipc-'));
  const endpoint = dir ? path.join(dir, 'host.sock') : `\\\\.\\pipe\\browsermcp-${instanceId}`;
  const connections = new Set<SocketTransport>();
  const cleanup = new Set<Promise<void>>();
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    void (async () => {
      const request = await readControl(socket);
      if (request?.op !== 'probe') throw new Error('Expected host probe');
      const health = await opts.probe();
      if (socket.destroyed) return;
      socket.write(JSON.stringify({ ...health, pid: process.pid, instanceId, startedAt, version: opts.version }) + '\n');
      const attach = await readControl(socket, 15000);
      if (attach?.op !== 'attach' || !health.extensionResponsive) throw new Error('Host cannot attach');
      const transport = new SocketTransport(socket);
      const session = createMcpServer(rt, randomUUID(), { version: opts.version });
      connections.add(transport);
      let closing = false;
      const dispose = (): void => {
        if (closing) return;
        closing = true;
        connections.delete(transport);
        const task = session.close().catch(error => rt.emit('log', `session cleanup failed: ${String(error)}`)).then(() => {});
        cleanup.add(task);
        void task.finally(() => cleanup.delete(task));
      };
      // Socket close also covers failed MCP initialization and abrupt client exit.
      socket.once('close', dispose);
      void session.server.connect(transport).catch(error => {
        rt.emit('log', `IPC connection failed: ${String(error)}`);
        void transport.close();
      });
      socket.resume();
    })().catch(() => socket.destroy());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => { server.off('error', reject); resolve(); });
    });
    if (dir) fs.chmodSync(endpoint, 0o600);
  } catch (error) { removeIpcEndpoint(endpoint); throw error; }
  server.on('error', error => rt.emit('log', `IPC server error: ${error.message}`));
  return {
    endpoint, instanceId, startedAt,
    close: async () => {
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await Promise.all([...connections].map(connection => connection.close()));
      await stopped;
      await Promise.all([...cleanup]);
      removeIpcEndpoint(endpoint);
    },
  };
}
