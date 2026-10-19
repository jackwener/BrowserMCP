// browsermcp/adapter-sdk — the adapter contract (runtime). Pure: validate + return a descriptor, never register.

const ACCESS = new Set(['read', 'write']);

/** Validate an adapter descriptor and return it unchanged. No global state, no side effects. */
export function defineAdapter(descriptor) {
  const d = descriptor ?? {};
  if (typeof d.description !== 'string' || !d.description.trim()) throw new Error('adapter: `description` (non-empty string) is required');
  if (!ACCESS.has(d.access)) throw new Error("adapter: `access` must be 'read' or 'write'");
  if (typeof d.run !== 'function') throw new Error('adapter: `run` must be a function (ctx) => data');
  if (d.result !== undefined && (!['rows', 'value'].includes(d.result?.kind) || typeof d.result?.description !== 'string' || !d.result.description.trim() || d.result.fields !== undefined && (!d.result.fields || typeof d.result.fields !== 'object' || Object.values(d.result.fields).some((v) => typeof v !== 'string')) || d.result.paginated && d.result.kind !== 'rows')) throw new Error('adapter: `result` needs kind rows|value and a description; fields must be text and paginated applies to rows');
  if (d.args !== undefined) {
    if (!Array.isArray(d.args)) throw new Error('adapter: `args` must be an array');
    for (const a of d.args) if (!a || typeof a.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(a.name)) throw new Error(`adapter: arg name "${a?.name}" must be snake_case (agent-native)`);
  }
  return d;
}

/** A coded, agent-facing error an adapter can throw; the runtime surfaces { code, message, hint }. */
export class AdapterError extends Error {
  constructor(code, message, hint) { super(message); this.name = 'AdapterError'; this.code = code; this.hint = hint; }
}

/** Common coded failures, so adapters branch on one vocabulary. */
export const errors = {
  auth: (message = 'Not logged in', hint = 'Open the site and sign in, then retry.') => new AdapterError('auth_required', message, hint),
  empty: (message = 'No results') => new AdapterError('empty_result', message),
  argument: (message, hint) => new AdapterError('invalid_args', message, hint),
  upstream: (message, hint) => new AdapterError('upstream_error', message, hint),
};
