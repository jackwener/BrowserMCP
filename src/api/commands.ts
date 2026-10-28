/** Session-bound commands shared by MCP and the code-mode helper. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Browser } from './browser.js';
import { ActionError, errorEnvelope } from './errors.js';
import { ACTION_RULES, targetShape, expectationShape } from './action-input.js';
import { parseInput } from '../shared/api-contract.js';
import type { ActOptions } from './tab.js';

const tabId = z.string().min(1).describe('Session page handle returned by claim_tab, open_tab or tabs_list. Never a numeric backendId.');
const actionVariants = Object.entries(ACTION_RULES).map(([action, rule]) => {
  const shape: Record<string, z.ZodType> = {
    action: z.literal(action), timeoutMs: z.number().int().nonnegative().optional(),
    settleMs: z.number().int().min(0).max(10000).optional(),
  };
  if (rule.target !== 'forbidden') shape.target = rule.target === 'optional' ? targetShape.optional() : targetShape;
  if (rule.value !== 'forbidden') shape.value = rule.value === 'present' ? z.string() : z.string().min(1);
  if (rule.files === 'required') shape.files = z.array(z.string().min(1)).min(1);
  if (rule.to === 'required') shape.to = targetShape;
  if (rule.scroll) { shape.direction = z.enum(['up', 'down', 'left', 'right']).optional(); shape.amount = z.number().finite().optional(); }
  if (action === 'click') shape.method = z.enum(['cdp', 'dom']).optional();
  return z.object(shape).strict();
});
const actionSchema = z.union(actionVariants as [typeof actionVariants[number], typeof actionVariants[number], ...typeof actionVariants]);
const observeSchema = z.object({
  cursor: z.string().optional(), mode: z.enum(['state', 'screenshot', 'both']).optional(),
  format: z.enum(['aria', 'dom']).optional(), target: targetShape.optional(),
  viewport: z.boolean().optional(), includeFrames: z.boolean().optional(), fullPage: z.boolean().optional(),
  limit: z.number().int().positive().optional(), start: z.number().int().nonnegative().optional(),
}).strict();

export function createBrowserCommands(browser: Browser) {
  function command<S extends z.ZodRawShape, R>(description: string, shape: S, readOnly: boolean, execute: (input: z.output<z.ZodObject<S>>) => Promise<R>) {
    const inputSchema = z.object(shape).strict();
    return { description, inputSchema, readOnly, execute, call: (input: unknown) => execute(parseInput('helper', inputSchema, input)) };
  }
  type Row = { tabId?: string; backendId: number; url?: string; title?: string; ownership: 'session' | 'unclaimed'; active: boolean; lifecycle?: string };
  // Bounded, immutable inventory snapshots: pagination cannot skip/repeat tabs as the browser changes.
  const snapshots = new Map<string, { items: Row[]; created: number; scope: 'all' | 'session' | 'unclaimed' }>();
  const commands = {
    session_finish: command('Finish the task: unmarked agent tabs close, user tabs and deliverables release, handoff tabs retain ownership and usable handles. Returns closed/released/retained/failed separately.', {
      keep: z.array(z.object({ tab: tabId, status: z.enum(['deliverable', 'handoff']) }).strict()).default([]),
    }, false, async ({ keep }) => browser.tabs.finalize({ keep })),
    tabs_list: command('List session and unclaimed tabs without claiming, loading or focusing. Continue with cursor alone. Use tabId directly; claim an unclaimed backendId before operating.', {
      query: z.string().optional(), scope: z.enum(['all', 'session', 'unclaimed']).default('all'),
      limit: z.number().int().min(1).max(100).default(30), cursor: z.string().optional(),
    }, true, async ({ query, scope, limit, cursor }) => {
      for (const [id, s] of snapshots) if (Date.now() - s.created > 300000) snapshots.delete(id);
      let items: Row[], key: string, offset = 0;
      if (cursor) {
        const parts = cursor.split(':'); key = parts[0]!; offset = Number(parts[1]);
        const snapshot = snapshots.get(key);
        if (parts.length !== 2 || !snapshot || !Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.items.length) throw new ActionError('stale_cursor', 'Inventory cursor expired or is invalid.', 'Call tabs_list without cursor.');
        if (query !== undefined || scope !== 'all') throw new ActionError('invalid_args', 'Continue a snapshot with cursor and optional limit only.');
        items = snapshot.items; scope = snapshot.scope;
      } else {
        items = [];
        if (scope !== 'unclaimed') for (const t of await browser.tabs.list()) items.push({ tabId: t.id, backendId: t.tabId, url: t.url, title: t.title, active: t.active, lifecycle: t.lifecycle, ownership: 'session' });
        if (scope !== 'session') {
          // One backend read prevents offset races while assembling the snapshot.
          const inventory = await browser.user.openTabs({ query, limit: 10000 });
          if (inventory.hasMore) throw new ActionError('inventory_too_large', 'Inventory exceeds one backend page.', 'Use a narrower query or browser.user.openTabs pagination in js.');
          for (const t of inventory.items) if (!items.some(r => r.backendId === t.tabId)) items.push({ backendId: t.tabId, url: t.url, title: t.title, active: t.active, lifecycle: t.lifecycle, ownership: 'unclaimed' });
        }
        const q = query?.trim().toLowerCase();
        if (q) items = items.filter(t => `${t.title ?? ''}\n${t.url ?? ''}`.toLowerCase().includes(q));
        key = randomUUID(); snapshots.set(key, { items, created: Date.now(), scope });
        if (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!);
      }
      const next = offset + limit;
      return { items: items.slice(offset, next), total: items.length, complete: next >= items.length, ...(next < items.length && { nextCursor: `${key}:${next}` }), snapshot: key, scope, excluded: 'Tabs owned by other sessions and unsupported tabs are not listed.' };
    }),
    claim_tab: command('Acquire an existing user tab. Exactly one selector: backendId, active:true, or unique URL/title. Does not create a tab.', {
      backendId: z.number().int().positive().optional(), active: z.literal(true).optional(), url: z.string().optional(), title: z.string().optional(),
      expectedUrl: z.string().optional(), expectedTitle: z.string().optional(),
    }, false, async ({ backendId, ...selector }) => {
      const tab = await browser.user.claimTab({ ...selector, ...(backendId !== undefined && { tabId: backendId }) });
      return { tabId: tab.id };
    }),
    open_tab: command('Explicitly create a new tab. Prefer navigate_tab to reuse an existing tab.', { url: z.string().optional() }, false, async ({ url }) => ({ tabId: (await browser.tabs.new(url)).id })),
    navigate_tab: command('Navigate the specified session tab in place. Never creates a tab, including on failure. Reuse its tabId for subsequent operations. For SPA readiness, pass ready (the same conditions as tab.expect) and timeoutMs; DOM settling alone does not guarantee loaded content.', {
      tabId, ready: expectationShape.optional(), timeoutMs: z.number().int().nonnegative().optional(), url: z.string().min(1), waitUntil: z.enum(['load', 'none']).default('load'), settleMs: z.number().int().min(0).max(10000).optional(),
    }, false, async ({ tabId, url, ...options }) => ({ tabId, ...await (await browser.tabs.get(tabId)).goto(url, options) })),
    close_tab: command('Close exactly one session-owned tab. For a user tab, claim it first. Closing is different from releasing control.', { tabId }, false, async ({ tabId }) => {
      await (await browser.tabs.get(tabId)).close(); return { tabId, closed: true };
    }),
    tabs_close: command('Close explicit session tab handles; returns an outcome for each tab, including partial failure. Never targets the current tab implicitly.', { tabIds: z.array(tabId).min(1).max(100) }, false, async ({ tabIds }) => {
      const results = [];
      for (const id of new Set(tabIds)) {
        try { await (await browser.tabs.get(id)).close(); results.push({ tabId: id, closed: true }); }
        catch (error) { results.push({ tabId: id, closed: false, ...errorEnvelope(error) }); }
      }
      return { complete: results.every(r => r.closed), results };
    }),
    release_tab: command('Leave the tab open and relinquish session control. Its handle becomes unusable until claimed again.', { tabId }, false, async ({ tabId }) => {
      await (await browser.tabs.get(tabId)).release(); return { tabId, released: true };
    }),
    tab_observe: command('Observe a session tab. Continue captured state using options.cursor. No implicit tab selection.', { tabId, options: observeSchema.default({}) }, true, async ({ tabId, options }) => ({ tabId, ...await (await browser.tabs.get(tabId)).observe(options) })),
    tab_act: command('Perform one action on an explicit session tab. Input delivery does not prove task completion; observe or verify the resulting page before deciding the next action.', { tabId, action: actionSchema }, false, async ({ tabId, action }) => ({ tabId, ...await (await browser.tabs.get(tabId)).act(action as unknown as ActOptions) })),
  };
  return commands;
}
export type BrowserCommands = ReturnType<typeof createBrowserCommands>;
export type BrowserHelper = { [K in keyof BrowserCommands]: (input: z.input<BrowserCommands[K]['inputSchema']>) => ReturnType<BrowserCommands[K]['call']> };
export function browserHelper(commands: BrowserCommands): BrowserHelper {
  return Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, command.call])) as BrowserHelper;
}
