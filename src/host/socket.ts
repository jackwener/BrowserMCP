/** Standard MCP stream framing over local IPC, shared by both ends of the connection. */
import net from 'node:net';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

export class SocketTransport extends StdioServerTransport {
  private closing: Promise<void> | undefined;
  constructor(readonly socket: net.Socket) {
    super(socket, socket);
    socket.once('close', () => { void this.close(); });
  }

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
