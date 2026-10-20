import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Runtime } from '../runtime/runtime.js';
import { createMcpServer } from '../mcp/server.js';
import { ElectronBackend, type ElectronBackendOptions } from '../electron/backend.js';
import type { PageScope, PageRegistration, EmbeddedPageEvent } from '../electron/registry.js';
import type { Source } from '../sites/loader.js';
import type { WebContents } from 'electron';

export interface EmbeddedOptions {
  /** Absolute writable directory owned by the application, normally under app.getPath('userData'). */
  dataDir: string;
  browser: ElectronBackendOptions;
  /** Explicit read-only adapter sources. Writable adapters in dataDir override these sources. */
  sources?: Source[];
  /** Current REPL and adapter modules execute trusted Node code. Must be acknowledged by the host. */
  execution: 'trusted-node';
  version?: string;
  log?: (message: string) => void;
}

/** No setup, global configuration, host discovery, stdio mutation, or process handlers. */
export async function createEmbeddedBrowser(options: EmbeddedOptions) {
  if (!path.isAbsolute(options.dataDir)) throw new Error('Embedded dataDir must be an absolute application-owned path');
  if (options.execution !== 'trusted-node') throw new Error('This evaluator requires explicit trusted-node execution');
  const backend = new ElectronBackend(options.browser);
  const runtime = new Runtime({ backend, sources: options.sources ?? [], userAdaptersDir: path.join(options.dataDir, 'adapters'), log: options.log });
  await runtime.init();
  const sessions = new Map<string, () => Promise<void>>();
  let disposal: Promise<void> | undefined;
  let disposed = false;
  function registerPage(contents: WebContents, scope: PageScope): string;
  function registerPage(registration: PageRegistration): string;
  function registerPage(input: WebContents | PageRegistration, scope?: PageScope): string {
    if (disposed) throw new Error('Embedded browser is disposed');
    return scope ? backend.register(input as WebContents, scope) : backend.register(input as PageRegistration);
  }
  return {
    registerPage,
    updatePage: backend.registry.update.bind(backend.registry),
    setActivePage: backend.registry.setActive.bind(backend.registry),
    getPages: backend.registry.list.bind(backend.registry),
    subscribe: (listener: (event: EmbeddedPageEvent) => void) => {
      if (disposed) throw new Error('Embedded browser is disposed');
      return backend.registry.subscribe(listener);
    },
    unregisterPage: backend.unregister.bind(backend),
    /** Scope is supplied by the host, never taken from MCP client input. */
    createSession(scope: PageScope) {
      if (disposed) throw new Error('Embedded browser is disposed');
      const id = randomUUID();
      backend.bindSession(`mcp:${id}`, scope);
      const session = createMcpServer(runtime, id, { version: options.version });
      let closing: Promise<void> | undefined;
      const close = (): Promise<void> => closing ??= (async () => {
        await session.close();
        await backend.closeSession(`mcp:${id}`);
        await session.server.close();
        sessions.delete(id);
      })().catch(error => { closing = undefined; throw error; });
      sessions.set(id, close);
      const existingClose = session.server.server.onclose;
      session.server.server.onclose = () => { existingClose?.(); void close().catch(error => options.log?.(`Session cleanup failed: ${String(error)}`)); };
      return { id, server: session.server, api: session.api, close };
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      disposal = (async () => {
        const results = await Promise.allSettled([...sessions.values()].map(close => close()));
        const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Embedded session cleanup failed');
        await runtime.shutdown();
      })().catch(error => { disposal = undefined; throw error; });
      return disposal;
    },
  };
}

export { ElectronBackend } from '../electron/backend.js';
export type { ElectronBackendOptions } from '../electron/backend.js';
export type { PageScope, PageRegistration, PageSnapshot, EmbeddedPageEvent } from '../electron/registry.js';
