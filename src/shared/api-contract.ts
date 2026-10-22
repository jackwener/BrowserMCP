/** Executable contracts shared by the public API, backend discovery and documentation. */
import { z } from 'zod';
import { ActionError } from '../api/errors.js';

/** Internal RPC function source; user data objects cannot impersonate this marker. */
export class PageFunction { constructor(readonly source: string) {} }

export function parseInput<T>(method: string, schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ActionError('invalid_args', `${method}: ${result.error.issues.map(i => `${i.path.join('.') || 'options'}: ${i.message}`).join('; ')}`,
    `Read docs_get api-reference for ${method}. Unknown fields are rejected.`,
    { method, dispatched: false, issues: result.error.issues.map(i => ({ path: i.path, message: i.message })) });
  return result.data;
}

export function checkArity(method: string, count: number, min: number, max: number): void {
  if (count < min || count > max) throw new ActionError('invalid_args', `${method} expects ${min}–${max} arguments; received ${count}.`, undefined, { method, dispatched: false });
}

const frameStep = z.union([z.string().min(1), z.number().int().nonnegative()]);
export const evaluateOptions = z.strictObject({
  arg: z.unknown().optional(),
  frame: z.union([frameStep, z.array(frameStep).min(1)]).optional(),
  timeoutMs: z.number().int().min(1).max(300_000).optional(),
});
export type EvaluateOptions = z.infer<typeof evaluateOptions>;

/** Reject values that JSON would silently drop or alter. Undefined is only allowed as the root argument. */
export function pageArgument(value: unknown): string {
  const seen = new WeakSet<object>();
  function visit(v: unknown, path: string): void {
    const fail = () => { throw new ActionError('invalid_args', `Tab.evaluate: ${path} must be plain JSON data (finite numbers, strings, booleans, null, arrays or objects).`,
      'Convert special values explicitly before calling evaluate.', { method: 'Tab.evaluate', path, dispatched: false }); };
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') { if (!Number.isFinite(v) || Object.is(v, -0)) fail(); return; }
    if (typeof v !== 'object' || !v) return fail();
    if (seen.has(v)) return fail();
    const proto = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return fail();
    seen.add(v);
    const keys = Reflect.ownKeys(v);
    for (const key of keys) {
      if (Array.isArray(v) && key === 'length') continue;
      if (typeof key !== 'string') return fail();
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) return fail();
      if (Array.isArray(v) && !/^(0|[1-9]\d*)$/.test(key)) return fail();
      visit(descriptor.value, `${path}.${key}`);
    }
    if (Array.isArray(v) && keys.length !== v.length + 1) return fail();
    seen.delete(v);
  }
  if (value === undefined) return 'undefined';
  visit(value, 'arg');
  return `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
}

export const discoveryOptions = z.strictObject({
  query: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type TabDiscoveryOptions = z.infer<typeof discoveryOptions>;
export const userTabInfo = z.strictObject({
  tabId: z.number().int().positive(), title: z.string().optional(), url: z.string().optional(),
  windowId: z.number().int(), active: z.boolean(), groupId: z.number().int().optional(),
  lastAccessed: z.number().finite().optional(),
  lifecycle: z.enum(['dormant', 'loading', 'ready']).optional(),
  availability: z.enum(['ready', 'load_required', 'host_attachment_required']).optional(),
});
export type UserTabInfo = z.infer<typeof userTabInfo>;
export const discoveryResult = z.strictObject({
  scope: z.literal('unclaimed'), query: z.string(), matching: z.literal('case-insensitive-substring'),
  totalVisible: z.number().int().nonnegative(), totalInScope: z.number().int().nonnegative(),
  excluded: z.strictObject({ owned: z.number().int().nonnegative(), unsupported: z.number().int().nonnegative() }),
  matched: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100),
  hasMore: z.boolean(), nextOffset: z.number().int().nonnegative().optional(), items: z.array(userTabInfo),
}).superRefine((r, ctx) => {
  const count = Math.min(r.limit, Math.max(0, r.matched - r.offset));
  const more = r.offset + count < r.matched;
  if (r.totalVisible !== r.totalInScope + r.excluded.owned + r.excluded.unsupported || r.matched > r.totalInScope || r.items.length !== count || r.hasMore !== more || r.nextOffset !== (more ? r.offset + count : undefined))
    ctx.addIssue({ code: 'custom', message: 'Inconsistent discovery counts or pagination' });
});
export type TabDiscoveryResult = z.infer<typeof discoveryResult>;
export type TabInventoryEntry = { tab: UserTabInfo; owned: boolean; supported: boolean };

/** One snapshot, then scope → literal query → recency order → pagination. Never loads or claims a tab. */
export function discoverTabs(inventory: TabInventoryEntry[], input: TabDiscoveryOptions = {}): TabDiscoveryResult {
  const options = parseInput('Browser.user.openTabs', discoveryOptions, input);
  const query = (options.query ?? '').trim().toLowerCase();
  const limit = options.limit ?? 20, offset = options.offset ?? 0;
  const excluded = { owned: 0, unsupported: 0 };
  const scope = inventory.filter(entry => {
    if (!entry.supported) { excluded.unsupported++; return false; }
    if (entry.owned) { excluded.owned++; return false; }
    return true;
  }).map(entry => entry.tab);
  const matches = scope.filter(tab => !query || [tab.url, tab.title].some(value => value?.toLowerCase().includes(query)))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0) || a.tabId - b.tabId);
  const items = matches.slice(offset, offset + limit), hasMore = offset + items.length < matches.length;
  return { scope: 'unclaimed', query, matching: 'case-insensitive-substring', totalVisible: inventory.length, totalInScope: scope.length, excluded, matched: matches.length, offset, limit, hasMore, ...(hasMore ? { nextOffset: offset + items.length } : {}), items };
}
