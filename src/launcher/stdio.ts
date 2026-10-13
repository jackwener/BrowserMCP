/**
 * stdio launcher for local MCP hosts (Claude Code, Cursor, Codex, …).
 * Proxies to the Chrome-spawned host. Browser and site-adapter commands share that runtime.
 */
import type { Client } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { connectHost, HostConnectionError, readConfig, type HostConnection } from '../host/state.js';
import { buildInstructions } from '../docs/manifest.js';
import { localCatalog } from '../mcp/catalog.js';

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
  let connection: HostConnection | null = null;
  let closing = false;
  let server!: Server;
  const wire = (c: Client): void => {
    c.setNotificationHandler('notifications/tools/list_changed', async () => { await server.sendToolListChanged().catch(() => {}); });
    c.setNotificationHandler('notifications/resources/list_changed', async () => { await server.sendResourceListChanged().catch(() => {}); });
    c.setNotificationHandler('notifications/prompts/list_changed', async () => { await server.sendPromptListChanged().catch(() => {}); });
    c.setNotificationHandler('notifications/message', async (n) => { await server.sendLoggingMessage(n.params).catch(() => {}); });
  };
  const connectOnce = async (): Promise<HostConnection> => {
    const next = await connectHost(browserId);
    if (closing || next.transport.closed) {
      await next.client.close();
      throw new HostConnectionError('host_unavailable', 'Host connection closed during initialization.');
    }
    next.client.onclose = () => {
      if (connection !== next) return;
      connection = null;
      if (!closing) void server.sendToolListChanged().catch(() => {});
      log('host connection closed; will reconnect to the same browser');
    };
    browserId = next.state.browserId;
    sessionRestarted = hasConnected;
    hasConnected = true;
    wire(next.client);
    connection = next;
    void server.sendToolListChanged().catch(() => {});
    return next;
  };
  let connecting: Promise<HostConnection> | null = null;
  const ensure = async (): Promise<HostConnection> => {
    if (connection && !connection.transport.closed) return connection;
    if (!connecting) connecting = connectOnce().finally(() => { connecting = null; });
    return connecting;
  };
  // Discovery reads may be retried after a disconnect; writes must never be replayed blindly.
  const via = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    const upstream = await ensure();
    try { return await fn(upstream.client); }
    catch (err) {
      if (!upstream.transport.closed) throw err;
      return fn((await ensure()).client);
    }
  };
  const failure = (code: string, message: string, hint?: string, retryable = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code, message, ...(hint && { hint }), retryable } }) }], isError: true,
  });

  server = new Server({ name: 'opencli-mcp', version }, {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true }, logging: {} },
    instructions: buildInstructions({ backend: 'extension', capabilities: [] }),
  });

  const discover = async <T>(upstream: (c: Client) => Promise<T>, offline: T): Promise<T> => {
    try { return await via(upstream); }
    catch (err) { if (!(err instanceof HostConnectionError)) throw err; return offline; }
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
    let upstream: HostConnection;
    try { upstream = await ensure(); } catch (err) {
      if (err instanceof HostConnectionError) return failure(err.code, err.message, undefined, err.code === 'host_unavailable');
      throw err;
    }
    if (sessionRestarted) {
      sessionRestarted = false;
      return failure('session_restarted', 'The browser host reconnected with a new session. REPL bindings and old Tab handles are gone; this call was not executed.', 'Inspect current browser state and recreate bindings before continuing. Do not replay previous mutations blindly.');
    }
    try { return await call(upstream.client); } catch (err) {
      if (upstream.transport.closed) return failure('command_outcome_unknown', `Host connection dropped during the tool call: ${String((err as Error)?.message ?? err)}`, 'The command may have applied. Inspect browser or site state before deciding whether to run it again.');
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
  const watchHost = (): void => {
    if (!closing) void ensure().catch(() => { /* discovery remains available offline */ });
  };
  const hostWatch = setInterval(watchHost, 2000);
  hostWatch.unref();
  const bye = (why: string): void => {
    if (closing) return; closing = true;
    clearInterval(hostWatch);
    log(why);
    transport.onclose = undefined;
    void (async () => {
      await connection?.client.close().catch(() => {});
    })().finally(() => process.exit(0));
  };
  // Only the client (Codex/Claude) going away ends the launcher — never a host drop.
  transport.onclose = () => bye('stdio closed');
  process.stdin.once('end', () => bye('stdin ended'));
  await server.connect(transport);
  void watchHost();
}
