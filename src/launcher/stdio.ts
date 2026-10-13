/**
 * stdio launcher for local MCP hosts (Claude Code, Cursor, Codex, …).
 * Proxies to the Chrome-spawned host. Browser and site-adapter commands share that runtime.
 */
import { Client } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { discoverHost, readConfig } from '../host/state.js';
import { connectSocket } from '../host/socket.js';
import { buildInstructions } from '../docs/manifest.js';
import { localCatalog } from '../mcp/catalog.js';

class HostUnavailableError extends Error {}

export async function runStdio(opts: { version: string }): Promise<void> {
  const log = (m: string): void => { process.stderr.write(`[opencli-mcp] ${m}\n`); };
  await proxyToHost(opts.version, log);
}

async function proxyToHost(version: string, log: (m: string) => void): Promise<void> {
  let browserId = process.env.OPENCLI_MCP_BROWSER ?? readConfig().browserId;
  let hasConnected = false;
  let sessionRestarted = false;
  const catalog = await localCatalog(version);
  // The Chrome-spawned host restarts whenever the extension's Native port drops — an extension reload, a crash, or the
  // service worker being replaced. When that happens we must NOT kill the client's stdio channel (Codex/Claude don't
  // auto-reconnect a dead MCP server); we keep the stdio server up and reconnect to the host on demand, re-reading the
  // host registry (the same browser gets a fresh endpoint on restart).
  let client: Client | null = null;
  let clientGen = 0;
  let server!: Server;
  const wire = (c: Client): void => {
    c.setNotificationHandler('notifications/tools/list_changed', async () => { await server.sendToolListChanged().catch(() => {}); });
    c.setNotificationHandler('notifications/resources/list_changed', async () => { await server.sendResourceListChanged().catch(() => {}); });
    c.setNotificationHandler('notifications/prompts/list_changed', async () => { await server.sendPromptListChanged().catch(() => {}); });
    c.setNotificationHandler('notifications/message', async (n) => { await server.sendLoggingMessage(n.params).catch(() => {}); });
  };
  const connectOnce = async (): Promise<Client> => {
    let st;
    try { st = await discoverHost(browserId); }
    catch (error) { throw new HostUnavailableError((error as Error).message); }
    const c = new Client({ name: 'opencli-mcp-stdio', version }, { capabilities: {} });
    const up = await connectSocket(st.endpoint);
    const gen = ++clientGen;
    up.onclose = () => {
      if (gen !== clientGen) return;
      client = null;
      hostAvailable = false;
      if (stdioConnected && !closing) void server.sendToolListChanged().catch(() => {});
      log('host connection closed; will reconnect to the same browser');
    };
    up.onerror = () => { /* surfaced when a request fails; reconnect handles it */ };
    try { await c.connect(up, { timeout: 5000 }); }
    catch (error) { await up.close(); throw error; }
    browserId = st.browserId;
    sessionRestarted = hasConnected;
    hasConnected = true;
    wire(c);
    client = c;
    return c;
  };
  let connecting: Promise<Client> | null = null;
  const ensure = async (): Promise<Client> => {
    if (client) return client;
    if (!connecting) connecting = connectOnce().finally(() => { connecting = null; });
    return connecting;
  };
  const isDisconnect = (err: unknown): boolean => err instanceof HostUnavailableError || /closed|ECONNREFUSED|ECONNRESET|ENOENT|EPIPE|not connected|terminated/i.test(String((err as Error)?.message ?? err));
  // Discovery reads may be retried after a disconnect; writes must never be replayed blindly.
  const via = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    let upstream: Client | undefined;
    try { upstream = await ensure(); return await fn(upstream); }
    catch (err) {
      if (!isDisconnect(err)) throw err;
      if (client === upstream) client = null;
      await upstream?.close().catch(() => {});
      return fn(await ensure());
    }
  };
  const hostDownError = (err: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code: 'host_unavailable', message: `opencli-mcp host not reachable: ${String((err as Error)?.message ?? err)}`, hint: 'Open Chrome and enable the extension, then retry. Run opencli-mcp doctor if it stays unavailable.', retryable: true } }) }], isError: true });
  const unknownOutcomeError = (err: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code: 'command_outcome_unknown', message: `Host connection dropped during the tool call: ${String((err as Error)?.message ?? err)}`, hint: 'The command may have applied. Inspect browser or site state before deciding whether to run it again.', retryable: false } }) }], isError: true });

  server = new Server({ name: 'opencli-mcp', version }, {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true }, logging: {} },
    instructions: buildInstructions({ backend: 'extension', capabilities: [] }),
  });

  const discover = async <T>(upstream: (c: Client) => Promise<T>, offline: T): Promise<T> => {
    try { return await via(upstream); }
    catch (err) { if (!isDisconnect(err)) throw err; return offline; }
  };
  server.setRequestHandler('tools/list', async (r) => discover((c) => c.listTools(r.params), catalog.tools));
  // Long browser ops can run up to 30 min. Forward the client's progress token and abort signal so the host's progress
  // notifications reach the client and cancellation reaches the host. Never replay a call after losing its outcome.
  server.setRequestHandler('tools/call', async (r, ctx) => {
    const progressToken = (r.params as { _meta?: { progressToken?: string | number } })._meta?.progressToken;
    const call = (c: Client) => c.callTool(r.params, {
      timeout: 1_800_000,
      resetTimeoutOnProgress: true,
      signal: ctx.mcpReq.signal,
      ...(progressToken !== undefined
        ? { onprogress: (p) => { void ctx.mcpReq.notify({ method: 'notifications/progress', params: { ...p, progressToken } }); } }
        : {}),
    });
    let upstream: Client;
    try { upstream = await ensure(); } catch (err) { if (isDisconnect(err)) return hostDownError(err); throw err; }
    if (sessionRestarted) {
      sessionRestarted = false;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'session_restarted', message: 'The browser host reconnected with a new session. REPL bindings and old Tab handles are gone; this call was not executed.', hint: 'Inspect current browser state and recreate bindings before continuing. Do not replay previous mutations blindly.' } }) }], isError: true };
    }
    try { return await call(upstream); } catch (err) {
      if (isDisconnect(err)) { if (client === upstream) client = null; await upstream.close().catch(() => {}); return unknownOutcomeError(err); }
      throw err;
    }
  });
  server.setRequestHandler('resources/list', async (r) => discover((c) => c.listResources(r.params), catalog.resources));
  server.setRequestHandler('resources/templates/list', async (r) => discover((c) => c.listResourceTemplates(r.params), catalog.resourceTemplates));
  server.setRequestHandler('resources/read', async (r) => via((c) => c.readResource(r.params)));
  server.setRequestHandler('prompts/list', async (r) => discover((c) => c.listPrompts(r.params), catalog.prompts));
  server.setRequestHandler('prompts/get', async (r) => via((c) => c.getPrompt(r.params)));

  const transport = new StdioServerTransport();
  // MCP clients commonly cache tools/list. Notify them when the Chrome-owned host
  // appears, disappears, or is replaced, so configured site tools can be rediscovered.
  let checkingHost = false;
  let stdioConnected = false;
  let hostAvailable = false;
  const watchHost = async (): Promise<void> => {
    if (checkingHost || closing) return;
    checkingHost = true;
    try {
      let available = false;
      try { await ensure(); available = true; } catch { /* discovery remains available offline */ }
      if (available !== hostAvailable) {
        hostAvailable = available;
        if (stdioConnected) await server.sendToolListChanged().catch(() => {});
      }
    } finally { checkingHost = false; }
  };
  const hostWatch = setInterval(() => { void watchHost(); }, 2000);
  hostWatch.unref();
  let closing = false;
  const bye = (why: string): void => {
    if (closing) return; closing = true;
    clearInterval(hostWatch);
    log(why);
    transport.onclose = undefined;
    void (async () => {
      await client?.close().catch(() => {});
    })().finally(() => process.exit(0));
  };
  // Only the client (Codex/Claude) going away ends the launcher — never a host drop.
  transport.onclose = () => bye('stdio closed');
  process.stdin.once('end', () => bye('stdin ended'));
  await server.connect(transport);
  stdioConnected = true;
  void watchHost();
}
