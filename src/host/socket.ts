/** Standard MCP stream framing over local IPC, shared by both ends of the connection. */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

export interface HostProbe { pid: number; browserId: string; instanceId: string; startedAt: number; version: string; extensionResponsive: boolean }

/** One bounded control message before the socket becomes an MCP transport. */
export function readControl(socket: net.Socket, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error('Host handshake timed out')), timeoutMs);
    const clean = () => { clearTimeout(timer); socket.off('data', data); socket.off('close', closed); socket.off('error', fail); };
    const fail = (error: Error) => { clean(); reject(error); };
    const closed = () => fail(new Error('Host connection closed during handshake'));
    const data = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if ((end < 0 ? buffer.length : end) > 65536) return fail(new Error('Host handshake too large'));
      if (end < 0) return;
      socket.pause(); clean();
      if (buffer.length > end + 1) socket.unshift(buffer.subarray(end + 1));
      try { resolve(JSON.parse(buffer.subarray(0, end).toString())); } catch (error) { reject(error); }
    };
    socket.on('data', data); socket.once('close', closed); socket.once('error', fail); socket.resume();
    if (socket.destroyed) closed();
  });
}

export async function probeSocket(transport: SocketTransport): Promise<HostProbe> {
  const response = readControl(transport.socket);
  transport.socket.write('{"op":"probe"}\n');
  const value = await response;
  if (!value || typeof value.browserId !== 'string' || !value.browserId || typeof value.instanceId !== 'string' || !Number.isFinite(value.startedAt) || typeof value.extensionResponsive !== 'boolean' || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.version !== 'string') throw new Error('Invalid host identity');
  return value as HostProbe;
}

export function attachSocket(transport: SocketTransport): void {
  transport.socket.write('{"op":"attach"}\n');
  transport.socket.resume();
}

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
