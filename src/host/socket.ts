/** Standard MCP stream framing over local IPC, shared by both ends of the connection. */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

export class SocketTransport extends StdioServerTransport {
  private closing: Promise<void> | undefined;
  constructor(readonly socket: net.Socket) {
    super(socket, socket);
    socket.once('close', () => { void this.close(); });
  }

  get closed(): boolean { return this.socket.destroyed; }

  override close(): Promise<void> {
    // The SDK stream transport does not own its streams; this IPC transport does.
    if (!this.closing) {
      this.socket.destroy();
      this.closing = super.close();
    }
    return this.closing;
  }
}

export async function connectSocket(endpoint: string, timeoutMs = 1500): Promise<SocketTransport> {
  const socket = net.createConnection(endpoint);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => socket.destroy(new Error('Local host connection timed out')), timeoutMs);
    socket.once('error', fail);
    function fail(error: Error): void { clearTimeout(timer); reject(error); }
    socket.once('connect', () => { clearTimeout(timer); socket.off('error', fail); resolve(); });
  });
  // Cover the gap before Client.connect installs its error handlers.
  socket.on('error', () => {});
  return new SocketTransport(socket);
}

/** Only remove our socket and its now-empty directory, never arbitrary directory contents. */
export function removeIpcEndpoint(endpoint: string): void {
  if (process.platform === 'win32') return;
  const dir = path.dirname(endpoint);
  if (path.basename(endpoint) !== 'host.sock' || path.dirname(dir) !== path.resolve(os.tmpdir()) || !/^opencli-ipc-[\w-]+$/.test(path.basename(dir))) return;
  fs.rmSync(endpoint, { force: true });
  try { fs.rmdirSync(dir); } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}
