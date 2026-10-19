/**
 * Run an adapter: coerce args, provision the logged-in page, build the object-model context
 * `{ args, tab, sites, recon, signal }`, call the adapter's `run`, and shape the result.
 */
import { coerceArgs } from './schema.js';
import { ActionError } from '../api/errors.js';
import type { AdapterCommand } from './loader.js';
import type { RuntimePage } from '../backends/page-types.js';

export interface PageProvider {
  getAdapterPage(site: string): Promise<RuntimePage>;
  browserAvailable(): boolean;
  /** The object model bound to a page: the same `tab`/`sites`/`recon` an agent uses in `js`. */
  toolContext(page: RuntimePage, site: string): Promise<Record<string, unknown>>;
}

export interface CommandRunResult { ok: true; site: string; name: string; rows?: unknown[]; value?: unknown; nextCursor?: string; elapsedMs: number }
export interface CommandRunError { ok: false; site: string; name: string; error: { code: string; message: string; hint?: string; details?: Record<string, unknown> }; elapsedMs: number }

export const DEFAULT_TIMEOUT_MS = 120_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(() => reject(new ActionError('command_outcome_unknown', `${label} timed out after ${Math.round(ms / 1000)}s`, 'The adapter may still be running. Inspect browser or site state before retrying.'))), ms);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void => finish(() => reject(new ActionError('command_outcome_unknown', `${label} stopped waiting after client cancellation`, 'The adapter may still be running. Inspect browser or site state before retrying.')));
    // Attach before checking aborted, so a rejection from work already started cannot escape.
    p.then((v) => finish(() => resolve(v)), (e) => finish(() => reject(e)));
    if (signal?.aborted) onAbort();
    else if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runAdapter(
  provider: PageProvider,
  cmd: AdapterCommand,
  rawArgs: Record<string, unknown>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CommandRunResult | CommandRunError> {
  const started = Date.now();
  const key = `${cmd.site}/${cmd.name}`;
  try {
    const args = coerceArgs(cmd.args, rawArgs);
    if (opts.signal?.aborted) throw new ActionError('cancelled', `${key} cancelled by the client`);
    if (!provider.browserAvailable()) {
      throw new ActionError('browser_unavailable', `${key} needs a logged-in browser, but the Chrome extension is not connected`, 'Install the browsermcp extension and keep Chrome running (run `browsermcp doctor`).');
    }
    const page = await provider.getAdapterPage(cmd.site);
    const model = await provider.toolContext(page, cmd.site);
    if (opts.signal?.aborted) throw new ActionError('cancelled', `${key} cancelled by the client`);
    const ctx = { args, tab: model.tab, sites: model.sites, recon: model.recon, signal: opts.signal };
    const result = await withTimeout(Promise.resolve(cmd.run(ctx)), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, key, opts.signal);
    const isRows = Array.isArray(result) || Boolean(result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows));
    if (cmd.result?.kind === 'rows' && !isRows) throw new ActionError('adapter_result_mismatch', `${key} declared rows but returned a value.`, 'Return an array or {rows,nextCursor?}.');
    if (cmd.result?.kind === 'value' && isRows) throw new ActionError('adapter_result_mismatch', `${key} declared value but returned rows.`, 'Return a single value, or declare result.kind:"rows".');
    const elapsedMs = Date.now() - started;
    if (Array.isArray(result)) return { ok: true, site: cmd.site, name: cmd.name, rows: result, elapsedMs };
    if (result && typeof result === 'object') {
      const o = result as { rows?: unknown; nextCursor?: unknown };
      if (Array.isArray(o.rows)) return { ok: true, site: cmd.site, name: cmd.name, rows: o.rows, ...(typeof o.nextCursor === 'string' && { nextCursor: o.nextCursor }), elapsedMs };
      return { ok: true, site: cmd.site, name: cmd.name, value: result, elapsedMs };
    }
    return { ok: true, site: cmd.site, name: cmd.name, value: result, elapsedMs };
  } catch (err) {
    const elapsedMs = Date.now() - started;
    if (err instanceof ActionError) {
      const { code, message, hint, ...rest } = err.toJSON() as { code: string; message: string; hint?: string };
      return { ok: false, site: cmd.site, name: cmd.name, elapsedMs, error: { code: String(code), message: String(message), ...(hint ? { hint: String(hint) } : {}), ...rest } };
    }
    const e = (err ?? {}) as { code?: string; message?: string; hint?: string; details?: Record<string, unknown> };
    return {
      ok: false, site: cmd.site, name: cmd.name, elapsedMs,
      error: { code: e.code ?? 'command_failed', message: String(e.message ?? err), ...(e.hint && { hint: e.hint }), ...(e.details && { details: e.details }) },
    };
  }
}
