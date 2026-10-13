/** Per-browser host discovery. Endpoints are local IPC, never network addresses. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { connectSocket } from './socket.js';

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
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { clearHostState(s.instanceId); return []; }
      }
      return [s];
    } catch { return []; }
  });
}
export interface HostHealth { ok: boolean; backend?: string; sessions?: number; extensionConnected?: boolean; protocolWarning?: string | null; error?: string }
export async function hostHealth(s: HostState | null, timeoutMs = 1500): Promise<HostHealth> {
  if (!s) return { ok: false, error: 'No connected browser host' };
  const client = new Client({ name: 'opencli-mcp-doctor', version: '1' });
  try {
    const transport = await connectSocket(s.endpoint, timeoutMs);
    await client.connect(transport, { timeout: timeoutMs });
    const result = await client.callTool({ name: 'doctor', arguments: {} }, { timeout: timeoutMs });
    const text = result.content.find(item => item.type === 'text');
    if (!text || text.type !== 'text' || result.isError) throw new Error('Invalid host status');
    const report = JSON.parse(text.text) as { backend: string; sessions: number; extension: { connected: boolean; protocolWarning: string | null } };
    return { ok: true, backend: report.backend, sessions: Math.max(0, report.sessions - 1), extensionConnected: report.extension.connected, protocolWarning: report.extension.protocolWarning };
  } catch (error) { return { ok: false, error: (error as Error).message }; }
  finally { await client.close().catch(() => {}); }
}

/** Never silently switch profiles. An existing launcher pins its first browser ID. */
export async function discoverHost(browserId = process.env.OPENCLI_MCP_BROWSER ?? readConfig().browserId): Promise<HostState> {
  const states = readHostStates().filter(s => !browserId || s.browserId === browserId);
  const healthy = (await Promise.all(states.map(async s => (await hostHealth(s)).ok ? s : null))).filter((s): s is HostState => s !== null);
  if (healthy.length === 1) return healthy[0];
  if (!healthy.length) throw new Error(browserId ? `Browser ${browserId} is not connected. Open that profile and enable the extension.` : 'No browser host is connected. Open Chrome and enable the extension.');
  throw new Error(`Multiple browser hosts are connected. Set browserId in ~/.opencli-mcp/config.json or OPENCLI_MCP_BROWSER to one of: ${[...new Set(healthy.map(s => s.browserId))].join(', ')}`);
}
