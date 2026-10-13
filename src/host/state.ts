/** Per-browser host discovery. Endpoints are local IPC, never network addresses. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { connectSocket, removeIpcEndpoint, type SocketTransport } from './socket.js';

export const OPENCLI_MCP_DIR = path.join(os.homedir(), '.opencli-mcp');
export const RUN_DIR = path.join(OPENCLI_MCP_DIR, 'run');
export const CONFIG_FILE = path.join(OPENCLI_MCP_DIR, 'config.json');
export interface HostState { pid: number; browserId: string; instanceId: string; endpoint: string; version: string }
export interface Config { browserId?: string; cursor?: boolean; sites?: string[]; sitesWrite?: string[] }
export function readConfig(): Config {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Config; } catch { return {}; }
}
export function writeHostState(s: HostState): void {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(RUN_DIR, `${s.instanceId}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
export function clearHostState(instanceId: string): void {
  fs.rmSync(path.join(RUN_DIR, `${instanceId}.json`), { force: true });
}
export function readHostStates(): HostState[] {
  let files: string[];
  try { files = fs.readdirSync(RUN_DIR); } catch { return []; }
  return files.filter(f => /^[\da-f-]{36}\.json$/.test(f)).flatMap(file => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(RUN_DIR, file), 'utf8')) as HostState;
      if (!Number.isSafeInteger(s.pid) || s.pid <= 0 || !s.browserId || !s.endpoint || `${s.instanceId}.json` !== file) return [];
      try { process.kill(s.pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { removeIpcEndpoint(s.endpoint); clearHostState(s.instanceId); return []; }
      }
      return [s];
    } catch { return []; }
  });
}
export class HostConnectionError extends Error {
  constructor(readonly code: 'host_unavailable' | 'browser_selection_required', message: string) { super(message); }
}
export interface HostConnection { state: HostState; client: Client; transport: SocketTransport }

/** Initialize candidates once and retain the selected MCP connection for actual work. */
export async function connectHost(browserId = process.env.OPENCLI_MCP_BROWSER ?? readConfig().browserId, states = readHostStates()): Promise<HostConnection> {
  const candidates = states.filter(s => !browserId || s.browserId === browserId);
  const connected = (await Promise.all(candidates.map(async state => {
    const client = new Client({ name: 'opencli-mcp', version: '1' });
    let transport: SocketTransport | undefined;
    try {
      transport = await connectSocket(state.endpoint);
      await client.connect(transport, { timeout: 1500 });
      return { state, client, transport };
    } catch {
      await transport?.close();
      return null;
    }
  }))).filter((c): c is HostConnection => c !== null && !c.transport.closed);
  if (connected.length === 1) return connected[0];
  await Promise.all(connected.map(c => c.client.close().catch(() => {})));
  if (!connected.length) throw new HostConnectionError('host_unavailable', browserId
    ? `Browser ${browserId} is not connected. Open that profile and enable the extension.`
    : 'No browser host is connected. Open Chrome and enable the extension.');
  throw new HostConnectionError('browser_selection_required', `Multiple browser hosts are connected. Set browserId in ~/.opencli-mcp/config.json or OPENCLI_MCP_BROWSER to one of: ${[...new Set(connected.map(c => c.state.browserId))].join(', ')}`);
}
