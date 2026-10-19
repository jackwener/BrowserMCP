/** Per-browser host discovery. Endpoints are local IPC, never network addresses. */
import fs from 'node:fs';
import { BROWSERMCP_DIR } from '../lib/paths.js';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { connectSocket, probeSocket, attachSocket, removeIpcEndpoint, type SocketTransport } from './socket.js';

export const RUN_DIR = path.join(BROWSERMCP_DIR, 'run');
export const CONFIG_FILE = path.join(BROWSERMCP_DIR, 'config.json');
export interface HostState { pid: number; browserId: string; instanceId: string; endpoint: string; version: string; startedAt: number }
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

export interface HostDiagnostic { state: HostState; status: 'ready' | 'extension_unresponsive' | 'unreachable' | 'identity_mismatch' | 'attach_failed'; error?: string; selected?: boolean }

/** Probe without creating sessions. Browser identity is separate from process incarnation. */
export async function connectHost(browserId = readConfig().browserId, states = readHostStates(), diagnostics: HostDiagnostic[] = []): Promise<HostConnection> {
  const ready: Array<{ state: HostState; transport: SocketTransport; diagnostic: HostDiagnostic }> = [];
  await Promise.all(states.filter(s => !browserId || s.browserId === browserId).map(async registered => {
    const diagnostic: HostDiagnostic = { state: registered, status: 'unreachable' };
    diagnostics.push(diagnostic);
    let transport: SocketTransport | undefined;
    try {
      transport = await connectSocket(registered.endpoint);
      const probe = await probeSocket(transport);
      if (probe.browserId !== registered.browserId || probe.instanceId !== registered.instanceId) {
        diagnostic.status = 'identity_mismatch';
      } else {
        const { extensionResponsive, ...identity } = probe;
        diagnostic.state = { ...registered, ...identity };
        diagnostic.status = extensionResponsive ? 'ready' : 'extension_unresponsive';
        if (extensionResponsive && !transport.closed) {
          ready.push({ state: diagnostic.state, transport, diagnostic });
          return;
        }
      }
    } catch (error) { diagnostic.error = String((error as Error).message); }
    await transport?.close();
  }));
  try {
    const browsers = [...new Set(ready.map(c => c.state.browserId))].sort();
    if (browsers.length > 1) throw new HostConnectionError('browser_selection_required', `Multiple browsers are available. Set browserId in ~/.browsermcp/config.json to one of: ${browsers.join(', ')}`);
    ready.sort((a, b) => b.state.startedAt - a.state.startedAt || b.state.instanceId.localeCompare(a.state.instanceId));
    for (const candidate of ready) {
      const client = new Client({ name: 'browsermcp', version: '1' });
      try {
        attachSocket(candidate.transport);
        await client.connect(candidate.transport, { timeout: 1500 });
        if (candidate.transport.closed) throw new Error('Host closed during initialization');
        candidate.diagnostic.selected = true;
        if (ready.length > 1) process.stderr.write(`[browsermcp] ${ready.length} healthy hosts for browser ${candidate.state.browserId}; selected ${candidate.state.instanceId}. Existing sessions remain attached.\n`);
        return { state: candidate.state, client, transport: candidate.transport };
      } catch (error) {
        candidate.diagnostic.status = 'attach_failed'; candidate.diagnostic.error = String((error as Error).message);
        await client.close().catch(() => {});
        await candidate.transport.close();
      }
    }
    throw new HostConnectionError('host_unavailable', browserId
      ? `Browser ${browserId} has no responsive host. Open that profile and enable the extension; the next call will retry automatically.`
      : 'No responsive browser host. Open Chrome and enable the extension; the next call will retry automatically.');
  } finally {
    await Promise.all(ready.filter(c => !c.diagnostic.selected).map(c => c.transport.close()));
  }
}
