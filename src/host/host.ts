import { defaultSources, USER_ADAPTERS_DIR } from '../lib/sources.js';
/**
 * The Chrome-spawned native host: Native Messaging on stdio ⇄ extension, MCP over local IPC.
 * Lives exactly as long as the extension keeps its port open (Chrome's contract) — so the bridge,
 * the socket and the debugger attach stay warm together.
 */
import { Writable } from 'node:stream';
import { NativeChannel } from './native-messaging.js';
import { ExtensionBridge } from './bridge.js';
import { Runtime } from '../runtime/runtime.js';
import { startIpcServer } from './ipc.js';
import { clearHostState, readConfig, writeHostState } from './state.js';

export async function runNativeHost(opts: { version: string }): Promise<void> {
  const log = (m: string): void => { process.stderr.write(`[browsermcp host] ${m}\n`); };
  // stdout belongs to Native Messaging: route every other stdout write (console.log, library logs) to stderr
  const rawWrite = process.stdout.write.bind(process.stdout);
  const frames = new Writable({ write(chunk, _enc, cb) { rawWrite(chunk as Buffer, cb); } });
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => (process.stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
  const channel = new NativeChannel(process.stdin, frames);
  channel.on('error', (err) => log(`channel error: ${err.message}`));
  const bridge = new ExtensionBridge(channel);
  const config = readConfig();
  const rt = new Runtime({ sources: defaultSources(), userAdaptersDir: USER_ADAPTERS_DIR, bridge, cursor: config.cursor ?? false, sites: config.sites, sitesWrite: config.sitesWrite, log });
  await rt.init();
  const ipc = await startIpcServer(rt, { version: opts.version, probe: async () => ({ browserId: bridge.browserId ?? '', extensionResponsive: await bridge.probe() }) });
  bridge.ready = { version: opts.version };
  const publish = (): void => {
    if (!bridge.browserId) return;
    writeHostState({ pid: process.pid, browserId: bridge.browserId, instanceId: ipc.instanceId, endpoint: ipc.endpoint, startedAt: ipc.startedAt, version: opts.version });
  };
  bridge.on('hello', h => { log(`extension ${h.extensionVersion} connected`); if (bridge.protocolWarning) log(`warning: ${bridge.protocolWarning}`); publish(); });
  if (bridge.connected) { bridge.sendReady(); publish(); }
  rt.on('browser-event', (e) => log(`event ${e.kind}`));
  log(`listening on ${ipc.endpoint}`);

  let closing = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return; closing = true;
    log(`shutting down (${reason})`);
    clearInterval(healthTimer);
    const deadline = setTimeout(() => process.exit(1), 5000); deadline.unref();
    clearHostState(ipc.instanceId);
    await ipc.close().catch(() => {});
    await rt.shutdown().catch(() => {});
    process.exit(0);
  };
  let checking = false, failures = 0;
  const healthTimer = setInterval(() => {
    if (checking || closing) return;
    checking = true;
    void bridge.probe().then(ok => {
      failures = ok ? 0 : failures + 1;
      if (failures >= 3) void shutdown('extension unresponsive');
    }).finally(() => { checking = false; });
  }, 15000);
  healthTimer.unref();
  channel.on('error', () => void shutdown('native channel error'));
  channel.on('close', () => void shutdown('extension port closed'));
  // The extension can disconnect while runtime initialization is still awaiting I/O.
  if (channel.isClosed) { await shutdown('extension port closed during startup'); return; }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => { log(`uncaught: ${err.stack ?? err}`); void shutdown('uncaught exception'); });
  process.on('unhandledRejection', (err) => log(`unhandled: ${(err as Error)?.stack ?? err}`));
}
