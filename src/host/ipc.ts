/** One persistent MCP server/session per local socket. Chrome owns the shared runtime. */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Runtime } from '../runtime/runtime.js';
import { createMcpServer } from '../mcp/server.js';
import { SocketTransport, removeIpcEndpoint } from './socket.js';

export interface IpcServerHandle { endpoint: string; instanceId: string; close(): Promise<void> }

export async function startIpcServer(rt: Runtime, opts: { version: string }): Promise<IpcServerHandle> {
  const instanceId = randomUUID();
  const dir = process.platform === 'win32' ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-ipc-'));
  const endpoint = dir ? path.join(dir, 'host.sock') : `\\\\.\\pipe\\opencli-mcp-${instanceId}`;
  const connections = new Set<SocketTransport>();
  const cleanup = new Set<Promise<void>>();
  const server = net.createServer(socket => {
    socket.on('error', () => {});
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
    endpoint, instanceId,
    close: async () => {
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.all([...connections].map(connection => connection.close()));
      await stopped;
      await Promise.all([...cleanup]);
      removeIpcEndpoint(endpoint);
    },
  };
}
