/** Keep recovery evidence bounded; inventories belong in explicit discovery calls. */
export function compactErrorData(data: Record<string, unknown>): Record<string, unknown> {
  let budget = 4000;
  let truncated = false;
  function compact(value: unknown, depth: number): unknown {
    if (budget <= 0 || depth > 4) { truncated = true; return '[omitted]'; }
    if (typeof value === 'string') {
      const limit = Math.min(600, budget); budget -= Math.min(limit, value.length);
      if (value.length > limit) { truncated = true; return value.slice(0, limit) + '…'; }
      return value;
    }
    if (Array.isArray(value)) {
      if (value.length > 8) truncated = true;
      return value.slice(0, 8).map(item => compact(item, depth + 1));
    }
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      const entries = Object.entries(value);
      if (entries.length > 20) truncated = true;
      for (const [key, item] of entries.slice(0, 20)) {
        budget -= key.length;
        if (key === 'tabs' && Array.isArray(item)) { result.tabCount = item.length; result.tabDiscovery = 'Use tabs_list to inspect tabs.'; continue; }
        result[key] = compact(item, depth + 1);
      }
      return result;
    }
    return value;
  }
  const result = compact(data, 0) as Record<string, unknown>;
  return { ...result, ...(truncated ? { detailsTruncated: true } : {}) };
}

/** Stable, branchable errors for the object API and typed tools. */
export class ActionError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string, readonly data?: Record<string, unknown>) {
    super(message);
    this.name = 'ActionError';
  }
  toJSON(): Record<string, unknown> { return { ...compactErrorData(this.data ?? {}), code: this.code, message: this.message, ...(this.hint && { hint: this.hint }) }; }
}

export function errorEnvelope(err: unknown): { ok: false; error: Record<string, unknown> } {
  if (err instanceof ActionError) {
    return { ok: false, error: err.toJSON() };
  }
  const e = (err ?? {}) as { code?: string; message?: string; hint?: string; name?: string; data?: unknown };
  const data = e.data && typeof e.data === 'object' && !Array.isArray(e.data) ? e.data as Record<string, unknown> : {};
  const raw = e.code ?? (e.name === 'BrowserCommandError' ? 'browser_command_failed' : 'error');
  return { ok: false, error: { ...compactErrorData(data), code: raw, message: e.message ?? String(err), ...(e.hint && { hint: e.hint }) } };
}
