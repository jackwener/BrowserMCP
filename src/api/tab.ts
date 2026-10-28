import { PageFunction, checkArity, parseInput, evaluateOptions, pageArgument, type EvaluateOptions } from '../shared/api-contract.js';
import { pageTools, pageToolsUpdate, type PageTool, type PageToolsUpdate } from './webmcp.js';
import { watch } from './streams.js';
import type { StreamOptions, StreamReadOptions } from '../protocol.js';
/**
 * Tab — one browser tab of a session: observe (aria snapshot + semantic diff), find, act, expect, evaluate, screenshot,
 * network/console/dialog/webmcp/frames. A Tab owns the page object bound to its identity; operations are serialized per tab.
 */
import type { RuntimePage } from '../backends/page-types.js';
import { ActionError } from './errors.js';
import { checkActInput, checkExpect } from './action-input.js';
import { ARIA_REF_LINE } from '../shared/element-ref.js';
import { ariaDiff } from './diff.js';
import { networkDetail, networkSummary } from './network.js';
import { compactAria } from '../shared/aria-tree.js';
import { observationPage } from './observation.js';
import { targetToSelector, fallbackSelector, frameSteps } from '../shared/engine.js';
import type { Target, FindResult, QueryFindResult, ElementAtResult, Expectation, CheckResult, ReadTextResult, FrameObservation, FrameOwner, DomSnapshot, ElementDetails, ResolveFail } from '../shared/page-contract.js';
import type { DialogInfo, DownloadWaitResult, FrameStep } from '../protocol.js';
import type { SessionContext } from './context.js';

export type { Target } from '../shared/page-contract.js';

export type ActAction = 'click' | 'dblclick' | 'hover' | 'focus' | 'fill' | 'type' | 'press' | 'select' | 'check' | 'uncheck' | 'upload' | 'drag' | 'scroll' | 'back' | 'forward' | 'reload';

export interface ActOptions { target?: Target; action: ActAction; value?: string; files?: string[]; to?: Target; direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; timeoutMs?: number; settleMs?: number; /** click only. `dom` runs HTMLElement.click() and sends no mouse event. Default is a real mouse event. */ method?: 'cdp' | 'dom' }

/** Input delivery and control verification are separate from completion of the site's task. */
export interface ActionOutcome {
  action: ActAction;
  delivery: 'applied' | 'received' | 'dispatched';
  controlState: 'verified' | 'unverified';
  network?: { afterSequence: number; cursor: number };
  matches_n?: number;
  navigated?: boolean; url?: string; title?: string; timedOut?: boolean;
  ref?: string;
  /** For fill/type, true only when the settled value matches the requested result. */
  filled?: boolean; verified?: boolean; actual?: string;
  checked?: boolean; changed?: boolean; selected?: string[]; files?: number;
  openedTabs?: Array<{ tab?: string; tabId: number; url?: string; title?: string; pending?: true }>;
  download?: { tab: string; afterSequence: number; started: Array<{ seq: number; guid?: string; url: string; suggestedFilename: string }> };
  /** Present when the action used DOM activation or a native control setter. */
  method?: 'dom';
}

export interface ObserveOptions {
  /** Continue the previous immutable capture. Pass cursor alone; a fresh observation replaces it. */
  cursor?: string;
  mode?: 'state' | 'screenshot' | 'both';
  /** ARIA overview (default) or independent visible controls and live DOM attributes. */
  format?: 'aria' | 'dom';
  /** Frame path from an observation; identical to target.frame in act/find/read. */
  frame?: FrameStep | FrameStep[];
  /** Return a diff only against this exact snapshot id; otherwise return full state. ARIA only. */
  since?: string;
  /** ARIA defaults to the whole document; DOM defaults to the viewport. */
  viewport?: boolean;
  /** Open a branch in the selected frame. */
  ref?: string;
  /** Observe a known container using the same locator contract as read/act, without first obtaining a ref. */
  target?: Target;
  /** DOM pagination within the selected frame. The live page can change between calls. */
  start?: number;
  limit?: number;
  /** Include child frames, without scrolling. Default true. */
  includeFrames?: boolean;
  /** Overlay main-frame ref labels on the screenshot. */
  annotate?: boolean;
  fullPage?: boolean;
}
export interface ObservedContent { /** Long URL/title/frame metadata was abbreviated; page evidence uses cursor pagination. */ metadataTruncated?: boolean; /** A single oversized text line can span pages. Concatenate these fragments before interpreting it. */ stateContinued?: boolean; stateContinues?: boolean; state?: string; dom?: DomSnapshot; warnings?: string[]; diff?: boolean; changed?: { added: number; removed: number; changed?: number } }
export interface ObservedFrame extends ObservedContent { frame: FrameStep[]; owner: FrameOwner; unavailable?: string }
export interface ObserveResult extends ObservedContent {
  /** Whether this is the final output page, not a claim that all dynamic page content was captured. */
  complete?: boolean;
  /** Page-provided tool catalog changes in the observed root frame; schemas are fetched explicitly. */
  webmcp?: PageToolsUpdate;
  /** Continue this captured state with observe({cursor: nextCursor}). */
  nextCursor?: string;
  /** Pass directly to tab.observe(result.next) to continue this capture. */
  next?: { cursor: string };
  url: string | null; title: string | null; snapshotId?: string; image?: ImageValue;
  /** Child frames and explicit routes for semantic locators or document reads; refs route automatically. */
  frames?: ObservedFrame[];
  /** False if a discovered frame could not be captured or the bounded traversal stopped. */
  framesComplete?: boolean;
}
export interface ReadOptions { /** stop after this many characters. Default 60000. */ maxChars?: number; /** character offset returned as nextStart by a previous read */ start?: number; /** capture id returned by that same read */ readId?: string; frame?: FrameStep | FrameStep[] }
export interface DocumentReadResult extends ReadTextResult { /** Pass directly to tab.read(result.next). */ next?: ReadOptions }
export interface ReadElementOptions { /** Exact current text, attributes and form values for one locator. No scrolling or preview clipping. */ target: Target }

export interface ImageValue { __image: true; mimeType: string; base64: string }


export class Tab {
  /** A Tab owns the page object bound to its identity; `bound` lets an adapter pass an existing page. */
  /** `id` is the stable backend page handle; `tabId` is the numeric backend id when claimed from a user tab. */
  readonly tabId?: number;
  constructor(private readonly initialId: string, private readonly ctx: SessionContext, private readonly bound?: RuntimePage, tabId?: number) { this.tabId = tabId; }
  get id(): string { return this.bound?.getActivePage() ?? this.initialId; }
  toJSON(): { type: 'Tab'; id: string; tabId?: number } { return { type: 'Tab', id: this.id, ...(this.tabId !== undefined && { tabId: this.tabId }) }; }
  private closed = false;

  /** Run `fn` on this tab's own page object. Operations are serialized per tab, never across tabs. */
  async use<T>(fn: (page: RuntimePage) => Promise<T>): Promise<T> {
    const state = this.ctx.state;
    const prev = state.tabLocks.get(this.id) ?? Promise.resolve();
    let release!: () => void;
    state.tabLocks.set(this.id, new Promise<void>((r) => { release = r; }));
    try {
      await prev;
      if (this.closed) throw new ActionError('stale_page', `tab ${this.id} was closed`, 'This Tab object is dead; open or claim another tab.');
      if (state.finalized && !state.pages.has(this.id)) throw new ActionError('page_released', `tab ${this.id} was released by finalize`, 'finalize ends the session\'s control of its tabs; open a new tab or claim the tab again (browser.user.claimTab).');
      const page = this.bound ?? await this.ctx.rt.pageFor(this.ctx.sessionId, this.id);
      return await fn(page);
    } finally { release(); }
  }

  /** Reuse the document namespace already present in refs; no second element-id system. */
  private rememberRefs(refs: string[], frame: FrameStep[] = []): void {
    let routes = this.ctx.state.refFrames.get(this.id);
    if (!routes) this.ctx.state.refFrames.set(this.id, routes = new Map());
    for (const ref of refs) {
      const scope = /^e([a-f0-9]{16})_/.exec(ref)?.[1];
      if (!scope || routes.has(scope)) continue;
      // A newer document at this exact route replaces its old routing entry.
      for (const [key, path] of routes) if (JSON.stringify(path) === JSON.stringify(frame)) routes.delete(key);
      routes.set(scope, frame);
    }
  }

  private routeTarget(target: Target): Target {
    if (target.frame !== undefined) return target;
    const identity = 'ref' in target ? target.ref : target.within;
    const scope = /^e([a-f0-9]{16})_/.exec(String(identity ?? ''))?.[1];
    const frame = scope && this.ctx.state.refFrames.get(this.id)?.get(scope);
    if (scope && !frame) throw new ActionError('stale_ref', 'This ref has no observed document in this tab.', 'Observe or find the target again; use its returned ref.');
    return frame?.length ? { ...target, frame } : target;
  }

  async goto(url: string, opts: { waitUntil?: 'load' | 'none'; settleMs?: number } = {}): Promise<{ url: string | null; title: string | null }> {
    if (!/^(https?:\/\/|data:text\/html)/i.test(url)) throw new ActionError('invalid_url', 'Only http(s) (or data:text/html) URLs can be opened', 'Pass an absolute http:// or https:// URL');
    return this.use(async (page) => {
      await page.goto(url, opts);
      await this.harvest(page);
      return this.info(page);
    });
  }

  /**
   * Pull captured requests into the session's bounded network log. Best effort — never fails a step.
   */
  private async harvest(page: RuntimePage): Promise<Array<Record<string, unknown> & { seq: number }>> {
    // best effort: harvesting must never fail the step that just succeeded
    try { const captured = await page.readNetworkCapture().catch(() => [] as unknown[]) as Array<Record<string, unknown>>; return this.logNetwork(captured); } catch { return []; }
  }
  private logNetwork(entries: Array<Record<string, unknown>>): Array<Record<string, unknown> & { seq: number }> {
    let log = this.ctx.state.netLog.get(this.id);
    if (!log) { log = { seq: 0, entries: [], seen: new Set(), bodyChars: 0 }; this.ctx.state.netLog.set(this.id, log); }
    const fresh: Array<Record<string, unknown> & { seq: number }> = [];
    for (const e of entries) {
      const key = String(e.requestId ?? `${e.method ?? 'GET'} ${e.url ?? e.name ?? ''} ${e.timestamp ?? e.startTime ?? e.ts ?? ''}`);
      if (log.seen.has(key)) continue;
      log.seen.add(key);
      const entry: Record<string, unknown> & { seq: number } = { ...e, seq: ++log.seq }; log.entries.push(entry); fresh.push(entry);
      log.bodyChars += String(entry.requestBodyPreview ?? '').length + String(entry.responsePreview ?? '').length;
    }
    while (log.entries.length > 2000 || log.bodyChars > 32_000_000 && log.entries.length > 1) {
      const oldest = log.entries.shift()! as Record<string, unknown>;
      log.bodyChars -= String(oldest.requestBodyPreview ?? '').length + String(oldest.responsePreview ?? '').length;
    }
    if (log.seen.size > 8000) log.seen.clear(); // bounded: the extension drains captured entries, so re-dup is rare
    return fresh;
  }
  private async info(page: RuntimePage): Promise<{ url: string | null; title: string | null }> {
    const url = await page.getCurrentUrl().catch(() => null);
    const title = await page.evaluate<string>('document.title').catch(() => null);
    return { url, title };
  }
  /** Preserve this tab for the user when the session is finalized. */
  async markDeliverable(): Promise<void> { await this.setRetention('deliverable'); }
  /** Preserve this tab for a subsequent turn; the same session handle remains usable after finalization. */
  async markHandoff(): Promise<void> { await this.setRetention('handoff'); }
  /** Restore default cleanup: close agent tabs, release borrowed user tabs. */
  async clearRetention(): Promise<void> { await this.setRetention(null); }
  private async setRetention(status: 'deliverable' | 'handoff' | null): Promise<void> {
    await this.use(async page => {
      if (!this.ctx.rt.isManagedPage(page)) throw new ActionError('capability_unavailable', 'This backend does not support tab retention');
      await page.mark(this.id, status);
    });
  }
  async url(): Promise<string | null> { return this.use((p) => p.getCurrentUrl()); }
  async title(): Promise<string | null> { return this.use((p) => p.evaluate<string>('document.title')); }
  async back(): Promise<void> { await this.use((p) => p.history('back')); }
  async forward(): Promise<void> { await this.use((p) => p.history('forward')); }
  async reload(): Promise<void> { await this.use((p) => p.history('reload')); }
  /** Close this tab, whether it was opened or claimed by this session. */
  async close(): Promise<void> { await this.use((p) => p.closeTab(this.id)); this.closed = true; this.ctx.rt.forgetPage(this.ctx.sessionId, this.id); }
  /** Keep this tab open and give up this session's control of it. */
  async release(): Promise<void> { await this.use((p) => p.releaseTab(this.id)); this.closed = true; this.ctx.rt.forgetPage(this.ctx.sessionId, this.id); }

  /** ARIA overview by default; format:'dom' reveals visible controls and live attributes. Observed refs automatically route to their frame. */
  async observe(opts: ObserveOptions = {}): Promise<ObserveResult> {
    if (opts.ref && opts.target) throw new ActionError('invalid_target', 'Use target or ref, not both.');
    if (opts.ref) { opts = { ...opts, target: { ref: opts.ref, ...(opts.frame !== undefined && { frame: opts.frame }) } }; delete opts.ref; delete opts.frame; }
    if (opts.target) opts = { ...opts, target: this.routeTarget(opts.target) };
    const mode = opts.mode ?? 'state';
    return this.use(async (page) => {
      if (opts.cursor !== undefined) {
        if (Object.keys(opts).some(key => key !== 'cursor')) throw new ActionError('invalid_argument', 'Pass cursor alone when continuing an observation.', 'Use tab.observe({cursor}) or start a fresh observation with other options.');
        const previous = this.ctx.state.observations.get(this.id);
        if (!previous) throw new ActionError('stale_observation', 'No captured observation remains for this tab.', 'Call tab.observe() for a fresh snapshot.');
        return observationPage(previous, opts.cursor);
      }
      const out: ObserveResult = { ...await this.info(page) };
      if (mode === 'state' || mode === 'both') {
        const snapshotId = `${++this.ctx.state.observationSeq}`;
        out.snapshotId = snapshotId;
        if (opts.target && opts.ref) throw new ActionError('invalid_target', 'Use either target or ref to scope an observation.', 'Pass one locator.');
        if (opts.target?.frame && opts.frame) throw new ActionError('invalid_target', 'Frame was specified twice.', 'Put frame in target.frame or observe.frame.');
        const selector = opts.target ? targetToSelector(opts.target) : null;
        if (opts.target && !selector) throw new ActionError('invalid_target', 'Observation scope needs a ref or locator.', 'Use find({x,y}) first for a screenshot coordinate.');
        const base = frameSteps(opts.target?.frame ?? opts.frame);
        const viewport = opts.ref || opts.target ? false : opts.viewport ?? (opts.format === 'dom');
        const render = (capture: FrameObservation, frame: FrameStep[], ref?: string): ObservedContent => {
          this.rememberRefs(capture.dom ? capture.dom.entries.map(entry => entry.ref) : (capture.state ?? '').split('\n').flatMap(line => { const match = ARIA_REF_LINE.exec(line); return match ? [match[2]] : []; }), frame);
          if (capture.dom) return { dom: { ...capture.dom, ...(capture.dom.nextStart !== undefined && { next: { format: 'dom' as const, ...(frame.length === base.length && opts.target ? {target:opts.target} : {frame}), start:capture.dom.nextStart, limit:opts.limit, viewport:!!viewport, includeFrames:false as const } }) } };
          let text = compactAria(capture.state ?? '');
          const key = `${this.id}:${JSON.stringify(frame)}:${viewport ? 'vp' : 'all'}:${ref ?? (frame.length === base.length ? selector ?? '' : '')}`;
          const prev = this.ctx.state.lastObserve.get(key);
          this.ctx.state.lastObserve.set(key, { id: snapshotId, text });
          const content: ObservedContent = { ...(capture.warnings && { warnings: capture.warnings }) };
          if (opts.since && prev?.id === opts.since) {
            const split = (value: string) => { const at = value.lastIndexOf('\nFocused: '); return at < 0 ? [value, ''] : [value.slice(0, at), value.slice(at + 1)]; };
            const [tree, focus] = split(text);
            const d = ariaDiff(split(prev.text)[0], tree);
            if (d.changedRatio < 0.6 || prev.text === text) {
              content.diff = true;
              content.changed = { added: d.added, removed: d.removed, changed: d.changed };
              text = (d.text || 'There has been no change since the last observe.') + (focus ? `\n${focus}` : '');
            }
          }
          content.state = text;
          return content;
        };
        const capture = (frame: FrameStep[], ref?: string, root = false) => page.pageCall('observeFrame', {
          format: opts.format ?? 'aria', viewport, ...(ref && { ref }),
          ...(root && { start: opts.start, limit: opts.limit, ...(selector && { selector, fallback: fallbackSelector(opts.target!) }) }),
        }, 5000, frame) as Promise<FrameObservation>;
        const root = await capture(base, opts.ref, true);
        Object.assign(out, render(root, base, opts.ref));
        if (root.warnings?.length) out.framesComplete = false;
        if (opts.includeFrames !== false && root.children.length) {
          out.frames = [];
          out.framesComplete = !root.warnings?.length;
          let captured = 0;
          const visit = async (parent: FrameStep[], owners: FrameOwner[], depth: number): Promise<void> => {
            for (const owner of owners) {
              const frame = [...parent, `aria-ref=${owner.ref}`];
              const result: ObservedFrame = { frame, owner };
              out.frames!.push(result);
              if (captured >= 24 || depth >= 8) result.unavailable = 'Frame traversal limit reached. Observe this frame directly.';
              else {
                captured++;
                try {
                  const child = await capture(frame);
                  Object.assign(result, render(child, frame));
                  await visit(frame, child.children, depth + 1);
                } catch (error) { result.unavailable = String((error as Error).message ?? error); }
              }
              if (result.unavailable || result.warnings?.length) out.framesComplete = false;
            }
          };
          await visit(base, root.children, 0);
        }
      }
      if (mode === 'state' || mode === 'both') {
        if (this.ctx.rt.hasFeature('webmcp')) {
          const frame = frameSteps(opts.target?.frame ?? opts.frame);
          out.webmcp = await pageToolsUpdate(page, this.ctx.state.webmcpCatalogs, `${this.id}:${JSON.stringify(frame)}`, frame);
        }
        this.ctx.state.observations.set(this.id, out);
        const result = observationPage(out);
        if (mode === 'both') result.image = await this.screenshotOn(page, { annotate: opts.annotate, fullPage: opts.fullPage });
        return result;
      }
      out.image = await this.screenshotOn(page, { annotate: opts.annotate, fullPage: opts.fullPage });
      return out;
    });
  }

  async screenshot(opts: { fullPage?: boolean; annotate?: boolean; format?: 'png' | 'jpeg'; quality?: number } = {}): Promise<ImageValue> {
    return this.use((page) => this.screenshotOn(page, opts));
  }
  private async screenshotOn(page: RuntimePage, opts: { fullPage?: boolean; annotate?: boolean; format?: 'png' | 'jpeg'; quality?: number }): Promise<ImageValue> {
    // annotate = ref labels of the last aria snapshot drawn by the page module for the capture only
    if (opts.annotate) await page.pageCall('annotate');
    try {
      const b64 = await page.screenshot({ fullPage: opts.fullPage, format: opts.format, quality: opts.quality });
      return { __image: true, mimeType: opts.format === 'jpeg' ? 'image/jpeg' : 'image/png', base64: b64 };
    } finally { if (opts.annotate) await page.pageCall('unannotate').catch(() => {}); }
  }

  async find(target: (Target & { limit?: number }) | { query: string; limit?: number; frame?: FrameStep | FrameStep[] }): Promise<FindResult | ElementAtResult | QueryFindResult> {
    if (!('query' in target)) target = this.routeTarget(target);
    return this.use(async (page) => {
      const remember = <T extends FindResult | ElementAtResult | QueryFindResult>(result: T): T => { this.rememberRefs(result.entries.flatMap(entry => entry.ref ? [entry.ref] : []), frameSteps(target.frame)); return result; };
      if ('query' in target) return remember(await page.pageCall('findByQuery', { query: target.query, limit: target.limit ?? 20 }, undefined, target.frame) as QueryFindResult);
      // a viewport point (screenshot coordinates) → the element there and its ancestors, as locators
      if ('x' in target) return remember(await page.pageCall('elementAt', { x: target.x, y: target.y }, undefined, target.frame) as ElementAtResult);
      // same engine and the same compiled selector as act: what find lists is exactly what act would resolve
      const spec = target as Record<string, unknown>;
      const selector = targetToSelector(spec);
      if (!selector) throw new ActionError('invalid_target', 'find needs a selector, an observed ref, a semantic locator (role/name/label/text/testid), or a point {x,y}', 'Pass one of: {ref} from observe, {selector}, {role,name}, {label}, {text}, {testid}, or {x,y}.');
      return remember(await page.pageCall('find', { selector, fallback: fallbackSelector(spec), limit: target.limit ?? 20 }, undefined, target.frame) as FindResult);
    });
  }

  /**
   * With target: exact current element text, attributes and live values, without scrolling.
   * Otherwise: bounded document text scan (including open shadow roots), restores scroll; pass result.next to continue.
   * A growing feed returns reason `unbounded`; the scan stops rather than chasing an endless bottom.
   */
  async read(opts: ReadElementOptions): Promise<ElementDetails>;
  async read(opts?: ReadOptions): Promise<DocumentReadResult>;
  async read(opts: ReadOptions | ReadElementOptions = {}): Promise<DocumentReadResult | ElementDetails> {
    if ('target' in opts) opts = { ...opts, target: this.routeTarget(opts.target) };
    return this.use(async (page) => {
      if ('target' in opts) {
        const selector = targetToSelector(opts.target);
        if (!selector) throw new ActionError('invalid_target', 'Exact read needs a ref or locator.', 'Use find({x,y}) first for a screenshot coordinate.');
        const result = await page.pageCall('readElement', { selector, fallback: fallbackSelector(opts.target), limit: 1 }, undefined, opts.target.frame) as ElementDetails | ResolveFail;
        if ('error' in result) throw new ActionError(result.error.code, result.error.message, result.error.hint);
        this.rememberRefs([result.ref], frameSteps(opts.target.frame));
        return result;
      }
      if (opts.start !== undefined && !opts.readId) throw new ActionError('invalid_args', 'Continuing a read requires both readId and start.', 'Copy readId and nextStart from the previous tab.read result.');
      const r = await page.pageCall('readText', opts, undefined, opts.frame) as ReadTextResult;
      if (r.reason === 'stale') throw new ActionError('stale_read', 'This page no longer has that text capture.', 'Call tab.read without readId to start a new capture.');
      return { ...r, ...(r.nextStart !== undefined && { next: { ...opts, readId: r.readId, start: r.nextStart } }) };
    });
  }

  /** wait + act in one call at the runtime edge: locate → wait actionable → hit-test → real input → settle. `method:'dom'` skips the mouse event. */
  async act(opts: ActOptions): Promise<ActionOutcome> {
    opts = { ...opts, ...checkActInput(opts) };
    if (opts.target) opts.target = this.routeTarget(opts.target);
    if (opts.to) opts.to = this.routeTarget(opts.to);
    const { action } = opts;
    return this.use(async (page) => {
      try {
        const capture = this.ctx.rt.hasFeature('network');
        if (capture) await this.harvest(page);
        const networkFrom = this.ctx.state.netLog.get(this.id)?.seq ?? 0;
        // use the page already held by this.use(): calling this.reload()/back()/forward() here would re-enter the session lock and deadlock
        if (action === 'back' || action === 'forward' || action === 'reload') {
          const h = await page.history(action);
          if (capture) await this.harvest(page);
          return { action, ...h, delivery: 'applied', controlState: 'unverified', ...(capture && { network: { afterSequence: networkFrom, cursor: this.ctx.state.netLog.get(this.id)?.seq ?? networkFrom } }) };
        }
        if (action === 'scroll' && !opts.target) {
          // no target: wheel at the viewport centre
          const vp = await page.evaluate<{ x: number; y: number }>('({ x: innerWidth / 2, y: innerHeight / 2 })');
          opts = { ...opts, target: { x: vp.x, y: vp.y } };
        }
        if (!opts.target) throw new ActionError('missing_target', `action "${action}" needs a target`, 'Pass a target: a {ref} from observe, or a selector/role+name/label/text/testid.');
        const r = await page.act({ kind: action, target: opts.target as Record<string, unknown>, value: opts.value, files: opts.files, to: opts.to as Record<string, unknown> | undefined, direction: opts.direction, amount: opts.amount, timeoutMs: opts.timeoutMs, settleMs: opts.settleMs ?? 600, cursor: this.ctx.rt.cursorEnabled, ...(opts.method ? { method: opts.method } : {}) });
        if (capture) await this.harvest(page);
        if (r.ref) this.rememberRefs([r.ref], frameSteps(opts.target.frame));
        const delivery = action === 'fill' || action === 'type' ? (r.verified ? 'applied' : 'dispatched') : r.method === 'dom' || ['check', 'uncheck', 'select', 'upload', 'focus'].includes(action) ? 'applied' : action === 'click' || action === 'dblclick' ? 'received' : 'dispatched';
        const controlVerified = r.verified === true || (action === 'check' && r.checked === true) || (action === 'uncheck' && r.checked === false) || (action === 'select' && Array.isArray(r.selected) && r.selected.length > 0);
        // Return the outcome and the fields needed to choose the next action.
        return {
          action,
          delivery,
          controlState: controlVerified ? 'verified' : 'unverified',
          ...(capture && { network: { afterSequence: networkFrom, cursor: this.ctx.state.netLog.get(this.id)?.seq ?? networkFrom } }),
          ...(r.matches_n > 1 ? { matches_n: r.matches_n } : {}),
          ...(r.navigated ? { navigated: true, ...(r.url !== undefined && { url: r.url }) } : {}),
          ...(r.ref ? { ref: r.ref } : {}),
          ...(r.filled !== undefined ? { filled: r.filled, verified: r.verified, actual: r.actual } : {}),
          ...(r.checked !== undefined ? { checked: r.checked, changed: r.changed } : {}),
          ...(r.selected !== undefined ? { selected: r.selected } : {}),
          ...(r.files !== undefined ? { files: r.files } : {}),
          ...(r.openedTabs?.length ? { openedTabs: r.openedTabs.map(({ page, tabId, url, title, pending }) => ({ ...(page && { tab: page }), tabId, url, title, ...(pending && { pending }) })) } : {}),
          ...(r.download ? { download: { ...r.download, tab: this.id } } : {}),
          ...(['click', 'fill', 'select'].includes(action) && r.method === 'dom' ? { method: 'dom' as const } : {}),
        };
      } catch (err) {
        if (err instanceof ActionError) throw err;
        const e = err as { code?: string; message?: string; hint?: string; data?: unknown };
        throw new ActionError(e.code ?? 'action_failed', e.message ?? String(err), e.hint, e.data && typeof e.data === 'object' ? e.data as Record<string, unknown> : undefined);
      }
    });
  }

  /** WebMCP: tools the page itself registers via navigator.modelContext (page-provided tool source). */
  readonly webmcp = {
    /** List names/descriptions, or fetch one full schema by name. Scoped to the requested frame. */
    list: async (options: { name?: string; frame?: FrameStep | FrameStep[] } = {}): Promise<PageTool[]> => this.use(async page => {
      const tools = await pageTools(page, frameSteps(options.frame));
      return options.name !== undefined ? tools.filter(tool => tool.name === options.name) : tools.map(({name, description}) => ({name, description}));
    }),
    call: async (name: string, input: Record<string, unknown> = {}, options: { frame?: FrameStep | FrameStep[] } = {}): Promise<unknown> => this.use(async page => {
      const script = `(async () => {
        const name = ${JSON.stringify(name)}, input = ${JSON.stringify(input)};
        const mc = navigator.modelContext || document.modelContext;
        if (typeof mc?.executeTool === 'function') return mc.executeTool(name, input);
        if (typeof navigator.modelContextTesting?.executeTool === 'function') return navigator.modelContextTesting.executeTool(name, JSON.stringify(input));
        const tools = await mc?.getTools?.();
        const tool = tools?.find(t => t.name === name);
        if (typeof tool?.execute !== 'function') throw new Error('Page tool is unavailable; refresh webmcp.list.');
        return tool.execute(input);
      })()`;
      return options.frame !== undefined ? page.evaluateInFrame(script, options.frame) : page.evaluate(script);
    }),
  };

  /** Assert what the page must show now (polled up to timeoutMs). */
  async expect(what: Expectation, opts: { timeoutMs?: number } = {}): Promise<CheckResult> {
    if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0)) throw new ActionError('invalid_args', 'timeoutMs must be a finite non-negative number.');
    checkExpect(what);
    if (what.target) what = { ...what, target: this.routeTarget(what.target) };
    return this.use(async (page) => {
      try { return await page.expect(what, opts); }
      catch (err) { const e = err as { code?: string; message?: string; hint?: string; extra?: Record<string, unknown> }; throw new ActionError(e.code ?? 'expectation_failed', e.message ?? String(err), e.hint, e.extra); }
    });
  }

  /** Main World page code; functions receive only opts.arg, never host closures. Dispatched scripts are never replayed. */
  async evaluate(script: string | ((arg: any) => any), opts: EvaluateOptions = {}): Promise<unknown> {
    checkArity('Tab.evaluate', arguments.length, 1, 2);
    const options = parseInput('Tab.evaluate', evaluateOptions, opts);
    const source = typeof script === 'function' ? script.toString() : ((script as unknown) instanceof PageFunction ? (script as unknown as PageFunction).source : undefined);
    if (!source && Object.hasOwn(options, 'arg')) throw new ActionError('invalid_args', 'Tab.evaluate: arg requires a function, not a source string.', 'Use tab.evaluate(value => ..., {arg: value}).', { dispatched: false });
    const expression = source ? `(${source})(${pageArgument(options.arg)})` : script;
    if (typeof expression !== 'string') throw new ActionError('invalid_args', 'evaluate expects page source or a function', undefined, { dispatched: false });
    return this.use(page => options.frame !== undefined ? page.evaluateInFrame(expression, options.frame, options.timeoutMs) : page.evaluate(expression, { timeoutMs: options.timeoutMs }));
  }

  /** Native CDP on this Tab's shared debugger attachment. Parameters are not rewritten. */
  readonly cdp = {
    send: async (method: string, params: Record<string, unknown> = {}, target?: { frameId: string }): Promise<unknown> => this.use(page => page.cdp(method, params, target)),
    watch: async (event: string, options?: StreamOptions) => this.use(async page => watch(this.ctx, 'cdp', event, options, this.id, {session: page.session, surface: page.surface})),
  };

  /** Native alert/confirm/prompt dialogs block the page; commands fail with `dialog_open` until answered. */
  readonly dialog = {
    get: async (): Promise<DialogInfo | null> => this.use(async (p) => (await p.dialog('get')).dialog),
    accept: async (text?: string): Promise<DialogInfo | null> => this.use(async (p) => (await p.dialog('accept', text)).dialog),
    dismiss: async (): Promise<DialogInfo | null> => this.use(async (p) => (await p.dialog('dismiss')).dialog),
  };

  /** Console messages and uncaught exceptions since the tab was attached (the plugin's tab.dev.logs); cursor-paged like network.read. */
  readonly console = {
    read: async (opts: StreamReadOptions = {}) => {
      if (!this.ctx.rt.hasFeature('streams')) throw new ActionError('capability_unavailable', 'This console cursor interface needs an extension with streams support.', 'Update the extension; other browser operations remain available.');
      return this.use(p => p.consoleLogs(opts));
    },
    watch: async (options?: StreamOptions) => this.use(async page => watch(this.ctx, 'console', undefined, options, this.id, {session: page.session, surface: page.surface})),
  };

  readonly network = {
    start: async (pattern = ''): Promise<boolean> => this.use((p) => p.startNetworkCapture(pattern)),
    list: async (opts: { filter?: string; limit?: number; afterSequence?: number } = {}): Promise<{ cursor: number; entries: Record<string, unknown>[]; hasMore: boolean }> => {
      const raw = await this.network.read({ pattern: opts.filter, limit: opts.limit ?? 30, afterSequence: opts.afterSequence });
      return { ...raw, entries: (raw.entries as Array<Record<string, unknown> & { seq: number }>).map(networkSummary) };
    },
    detail: async (opts: { seq?: number; requestId?: string; part?: 'request' | 'response'; start?: number; maxChars?: number }): Promise<Record<string, unknown>> => this.use(async (p) => {
      await this.harvest(p);
      const log = this.ctx.state.netLog.get(this.id);
      const entry = log?.entries.find((e) => opts.seq !== undefined ? e.seq === opts.seq : opts.requestId !== undefined && e.requestId === opts.requestId);
      if (!entry) throw new ActionError('network_entry_not_found', 'No captured request matches this seq or requestId.', 'Call network.list() and copy its seq.');
      return networkDetail(entry, opts);
    }),
    /**
     * Cursor-paged read: pass `afterSequence` from the previous result to get only new requests. Returns network rows
     * only; endpoint candidates come from the explicit `recon.discover(tab)` (not a hidden side effect of reading).
     */
    read: async (opts: { pattern?: string; limit?: number; includeStatic?: boolean; afterSequence?: number } = {}): Promise<{ cursor: number; entries: unknown[]; hasMore: boolean }> => this.use(async (p) => {
      await this.harvest(p);
      let log = this.ctx.state.netLog.get(this.id);
      // Interactive tabs use CDP capture as the authoritative log. Adapter tabs are not armed by default,
      // so they may fall back to Performance entries when their capture is empty.
      if ((!log || !log.entries.length) && p.surface === 'adapter') { this.logNetwork(await p.networkRequests(opts.includeStatic ?? false).catch(() => []) as Array<Record<string, unknown>>); log = this.ctx.state.netLog.get(this.id)!; }
      const after = opts.afterSequence ?? 0;
      const matching = (log?.entries ?? []).filter((e) => e.seq > after && (!opts.pattern || String(e.url ?? e.name ?? '').includes(opts.pattern)));
      const limit = opts.limit ?? 100;
      const page = matching.slice(0, limit);
      return { cursor: page.length ? page[page.length - 1].seq : after, entries: page, hasMore: matching.length > limit };
    }),
  };
  async cookies(domain: string): Promise<unknown[]> { return this.use((p) => p.getCookies({ domain })); }
  /**
   * Read one cookie's value at run time — useful for per-request tokens an adapter needs (csrf/ct0/
   * csrftoken/XSRF-TOKEN). Defaults to the current page's host. Returns undefined when the cookie is absent.
   */
  async cookie(name: string, opts: { domain?: string } = {}): Promise<string | undefined> {
    let domain = opts.domain;
    if (!domain) { const u = await this.url().catch(() => null); try { domain = u ? new URL(u).hostname : undefined; } catch { domain = undefined; } }
    const list = await this.use((p) => p.getCookies(domain ? { domain } : {})) as Array<{ name?: string; value?: string }>;
    return list.find((c) => c?.name === name)?.value;
  }
  /** Fetch JSON through the page (its cookies and origin) after verifying the endpoint. */
  async fetchJson(url: string, opts: Record<string, unknown> = {}): Promise<unknown> { return this.use((p) => p.fetchJson(url, opts as never)); }
  async frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string; crossOrigin?: boolean; oopif?: boolean }>> { return this.use((p) => p.frames()); }
  /** Wait for the page download begun after a tab.act cursor, then check Chrome's file state. */
  async download(download: NonNullable<ActionOutcome['download']>, timeoutMs = 30_000): Promise<DownloadWaitResult> {
    if (!download || download.tab !== this.id || !Number.isSafeInteger(download.afterSequence) || download.afterSequence < 0) throw new ActionError('invalid_args', 'Pass the download object returned by an action on this tab.', 'Use await tab.download(result.download).');
    return this.use((p) => p.waitForDownload(download.afterSequence, timeoutMs));
  }
}
