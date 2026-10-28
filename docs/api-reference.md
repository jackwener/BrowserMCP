## API reference (generated from the public TypeScript declarations — do not edit)

In `js` the globals are `browser`, `agent`, `sites`, `recon`, `tools`, `session` and `nodeRepl`. Await API methods; returned Tab and Browser handles persist across calls. Use docs_get with name:"api-reference" and member:"Tab.act" (or another class/member) for a focused reference. Site adapter definitions are documented in `define-tools`.

```ts
interface AgentApi {
  helper: {
    session_finish(input: { keep?: Array<{ tab: string; status: "deliverable" | "handoff"; }> | undefined; }): Promise<{ closed: Array<string>; released: Array<string>; retained: Array<string>; failed: Array<{ page: string; reason: string; }>; }>;
    tabs_list(input: { query?: string | undefined; scope?: "unclaimed" | "all" | "session" | undefined; limit?: number | undefined; cursor?: string | undefined; }): Promise<{ snapshot: string; scope: "unclaimed" | "all" | "session"; excluded: string; nextCursor?: string; items: Array<Row>; total: number; complete: boolean; }>;
    claim_tab(input: { backendId?: number | undefined; active?: true | undefined; url?: string | undefined; title?: string | undefined; expectedUrl?: string | undefined; expectedTitle?: string | undefined; }): Promise<{ tabId: string; }>;
    open_tab(input: { url?: string | undefined; }): Promise<{ tabId: string; }>;
    navigate_tab(input: { tabId: string; url: string; ready?: { target?: { ref?: string | number | undefined; selector?: string | undefined; within?: string | undefined; nth?: number | undefined; role?: string | undefined; name?: string | undefined; label?: string | undefined; text?: string | undefined; testid?: string | undefined; x?: number | undefined; y?: number | undefined; frame?: string | number | Array<string | number> | undefined; } | undefined; text?: string | undefined; notText?: string | undefined; url?: string | undefined; title?: string | undefined; visible?: boolean | undefined; value?: string | undefined; checked?: boolean | undefined; selected?: Array<string> | undefined; enabled?: boolean | undefined; } | undefined; timeoutMs?: number | undefined; waitUntil?: "load" | "none" | undefined; settleMs?: number | undefined; }): Promise<{ url: string | null; title: string | null; tabId: string; }>;
    close_tab(input: { tabId: string; }): Promise<{ tabId: string; closed: boolean; }>;
    tabs_close(input: { tabIds: Array<string>; }): Promise<{ complete: boolean; results: Array<{ tabId: string; closed: boolean; } | { ok: false; error: Record<string, unknown>; tabId: string; closed: boolean; }>; }>;
    release_tab(input: { tabId: string; }): Promise<{ tabId: string; released: boolean; }>;
    tab_observe(input: { tabId: string; options?: { cursor?: string | undefined; mode?: "state" | "screenshot" | "both" | undefined; format?: "aria" | "dom" | undefined; target?: { ref?: string | number | undefined; selector?: string | undefined; within?: string | undefined; nth?: number | undefined; role?: string | undefined; name?: string | undefined; label?: string | undefined; text?: string | undefined; testid?: string | undefined; x?: number | undefined; y?: number | undefined; frame?: string | number | Array<string | number> | undefined; } | undefined; viewport?: boolean | undefined; includeFrames?: boolean | undefined; fullPage?: boolean | undefined; limit?: number | undefined; start?: number | undefined; } | undefined; }): Promise<{ scope?: "target" | "viewport" | "document"; complete?: boolean; webmcp?: PageToolsUpdate; nextCursor?: string; next?: { cursor: string; }; url: string | null; title: string | null; snapshotId?: string; image?: ImageValue; frames?: Array<ObservedFrame>; framesComplete?: boolean; metadataTruncated?: boolean; stateContinued?: boolean; stateContinues?: boolean; state?: string; dom?: DomSnapshot; warnings?: Array<string>; diff?: boolean; changed?: { added: number; removed: number; changed?: number; }; tabId: string; }>;
    tab_act(input: { tabId: string; action: { [x: string]: unknown; }; }): Promise<{ action: ActAction; delivery: "applied" | "received" | "dispatched"; controlState: "verified" | "unverified"; network?: { afterSequence: number; cursor: number; }; matches_n?: number; navigated?: boolean; url?: string; title?: string; timedOut?: boolean; ref?: string; filled?: boolean; verified?: boolean; actual?: string; checked?: boolean; changed?: boolean; selected?: Array<string>; files?: number; openedTabs?: Array<{ tab?: string; tabId: number; url?: string; title?: string; pending?: true; }>; download?: { tab: string; afterSequence: number; started: Array<{ seq: number; guid?: string; url: string; suggestedFilename: string; }>; }; method?: "dom"; tabId: string; }>;
  };
  agent: { browsers: { getDefault(): Promise<Browser>; }; browser: Browser; documentation: { get(name: string): Promise<string | null>; }; };
  sites: Record<string, unknown> & { search(q: string, limit?: number): Promise<unknown>; list(): Promise<unknown>; enable(site: string, opts?: { write?: boolean; }): Promise<{ site: string; tools: Array<string>; }>; disable(site: string): Promise<boolean>; run(site: string, name: string, args?: Record<string, unknown>): Promise<unknown>; };
  recon: {
    discover(tab: Tab, opts?: { maxScripts?: number; includeStatic?: boolean; includeAssets?: boolean; includeInline?: boolean; fetchTimeoutMs?: number; network?: Array<Record<string, unknown>>; }): Promise<DiscoverResult>;
  };
  tools: {
    define(def: ToolDefinition | (Omit<ToolDefinition, "func"> & { func?: string | ((ctx: Record<string, unknown>) => unknown); })): Promise<{ draftId: string; site: string; name: string; args: Array<Arg>; }>;
    try(draftId: string, args: Record<string, unknown>, expect: DraftExpectation): Promise<{ result: CommandRunResult | CommandRunError; verification: { passed: boolean; checks: Array<{ check: string; passed: boolean; actual?: unknown; }>; }; }>;
    activate(draftId: string): Promise<{ site: string; name: string; file: string; verifiedAt: string; }>;
    discard(draftId: string): Promise<{ draftId: string; discarded: true; }>;
    list(): Promise<Array<{ site: string; name: string; file: string; }>>;
    remove(site: string, name: string): Promise<boolean>;
  };
  session: { id: string; };
}

class Browser {
  id: string;
  type: "extension" | "electron";
  chrome: { // Chrome APIs through the connected backend. Electron supports an explicit compatibility subset.
    call(method: string, args?: Array<unknown>): Promise<unknown>;
    describe(member: string): Promise<unknown>;
    watch(event: string, options?: StreamOptions): Promise<EventStream>;
  };
  logs: { // This extension's own service-worker logs; not logs of other installed extensions.
    watch(options?: StreamOptions): Promise<EventStream>;
    read(options?: StreamReadOptions): Promise<StreamBatch>;
  };
  tabs: {
    new(url?: string): Promise<Tab>;
    list(): Promise<Array<{ id?: string; tabId: number; pending?: true; url?: string; title?: string; active: boolean; selected: boolean; lifecycle?: "dormant" | "loading" | "ready"; origin: "agent" | "user"; state: "active" | "handoff"; }>>;
    get(tab: string | { tab?: string; tabId: number; }, opts?: { timeoutMs?: number; }): Promise<Tab>;
    selected(): Promise<Tab | undefined>;
    finalize(opts?: { keep?: Array<{ tab: string | Tab; status: "deliverable" | "handoff"; }>; }): Promise<{ closed: Array<string>; released: Array<string>; retained: Array<string>; failed: Array<{ page: string; reason: string; }>; }>;
  };
  user: {
    openTabs(...args: [options?: { query?: string | undefined; limit?: number | undefined; offset?: number | undefined; }]): Promise<{ scope: "unclaimed"; query: string; matching: "case-insensitive-substring"; totalVisible: number; totalInScope: number; excluded: { owned: number; unsupported: number; }; matched: number; offset: number; limit: number; hasMore: boolean; items: Array<{ tabId: number; windowId: number; active: boolean; title?: string | undefined; url?: string | undefined; groupId?: number | undefined; lastAccessed?: number | undefined; lifecycle?: "dormant" | "loading" | "ready" | undefined; availability?: "ready" | "load_required" | "host_attachment_required" | undefined; }>; nextOffset?: number | undefined; }>; // Unclaimed supported tabs in the visible scope. Query is trimmed, case-insensitive literal substring of URL OR title (no token splitting). Inspect items, matched, totalInScope, excluded and hasMore; continue with nextOffset. Each call takes a fresh snapshot.
    claimTab(tab: { tabId?: number; active?: boolean; title?: string; url?: string; expectedUrl?: string; expectedTitle?: string; }): Promise<Tab>; // Claim by foreground, id, or unique url/title lookup; expected fields verify the tab's current identity.
    closeTabs(tabIds: Array<number>): Promise<CloseUserTabsResult>; // Close user tabs by Chrome id without claiming or loading their pages.
  };
  nameSession(name: string): Promise<void>;
  capabilities: {
    list(): Promise<Array<{ id: string; description: string; }>>;
    get(id: string): Promise<Record<string, unknown>>;
  };
  documentation(): Promise<string>;
}

class Tab {
  tabId?: number; // `id` is the stable backend page handle; `tabId` is the numeric backend id when claimed from a user tab.
  id: string;
  goto(url: string, opts?: { waitUntil?: "load" | "none"; settleMs?: number; ready?: Expectation; timeoutMs?: number; }): Promise<{ url: string | null; title: string | null; }>;
  markDeliverable(): Promise<void>; // Preserve this tab for the user when the session is finalized.
  markHandoff(): Promise<void>; // Preserve this tab for a subsequent turn; the same session handle remains usable after finalization.
  clearRetention(): Promise<void>; // Restore default cleanup: close agent tabs, release borrowed user tabs.
  url(): Promise<string | null>;
  title(): Promise<string | null>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<{ tabId: string; closed: true; }>; // Close this tab, whether it was opened or claimed by this session.
  release(): Promise<void>; // Keep this tab open and give up this session's control of it.
  observe(opts?: ObserveOptions): Promise<ObserveResult>; // ARIA overview by default; format:'dom' reveals visible controls and live attributes. Observed refs automatically route to their frame.
  screenshot(opts?: { fullPage?: boolean; annotate?: boolean; format?: "png" | "jpeg"; quality?: number; }): Promise<ImageValue>;
  find(target: (Target & { limit?: number; }) | { query: string; limit?: number; frame?: FrameStep | Array<FrameStep>; }): Promise<FindResult | ElementAtResult | QueryFindResult>;
  read(opts: ReadElementOptions): Promise<ElementDetails>; // With target: exact current element text, attributes and live values, without scrolling. Otherwise: bounded document text scan (including open shadow roots), restores scroll; pass result.next to continue. A growing feed returns reason `unbounded`; the scan stops rather than chasing an endless bottom.
  read(opts?: ReadOptions): Promise<DocumentReadResult>; // With target: exact current element text, attributes and live values, without scrolling. Otherwise: bounded document text scan (including open shadow roots), restores scroll; pass result.next to continue. A growing feed returns reason `unbounded`; the scan stops rather than chasing an endless bottom.
  act(opts: ActOptions): Promise<ActionOutcome>; // wait + act in one call at the runtime edge: locate → wait actionable → hit-test → real input → settle. `method:'dom'` skips the mouse event.
  webmcp: { // WebMCP: tools the page itself registers via navigator.modelContext (page-provided tool source).
    list(options?: { name?: string; frame?: FrameStep | Array<FrameStep>; }): Promise<Array<PageTool>>; // List names/descriptions, or fetch one full schema by name. Scoped to the requested frame.
    call(name: string, input?: Record<string, unknown>, options?: { frame?: FrameStep | Array<FrameStep>; }): Promise<unknown>;
  };
  expect(what: Expectation, opts?: { timeoutMs?: number; }): Promise<CheckResult>; // Assert what the page must show now (polled up to timeoutMs).
  evaluate(script: string | ((arg: any) => any), opts?: { arg?: unknown; frame?: string | number | Array<string | number> | undefined; timeoutMs?: number | undefined; }): Promise<unknown>; // Main World page code; functions receive only opts.arg, never host closures. Dispatched scripts are never replayed.
  cdp: { // Native CDP on this Tab's shared debugger attachment. Parameters are not rewritten.
    send(method: string, params?: Record<string, unknown>, target?: { frameId: string; }): Promise<unknown>;
    watch(event: string, options?: StreamOptions): Promise<EventStream>;
  };
  dialog: { // Native alert/confirm/prompt dialogs block the page; commands fail with `dialog_open` until answered.
    get(): Promise<DialogInfo | null>;
    accept(text?: string): Promise<DialogInfo | null>;
    dismiss(): Promise<DialogInfo | null>;
  };
  console: { // Console messages and uncaught exceptions since the tab was attached (the plugin's tab.dev.logs); cursor-paged like network.read.
    read(opts?: StreamReadOptions): Promise<StreamBatch>;
    watch(options?: StreamOptions): Promise<EventStream>;
  };
  network: {
    start(pattern?: string): Promise<boolean>;
    list(opts?: { filter?: string; limit?: number; afterSequence?: number; }): Promise<{ cursor: number; entries: Array<Record<string, unknown>>; hasMore: boolean; }>;
    detail(opts: { seq?: number; requestId?: string; part?: "request" | "response"; start?: number; maxChars?: number; }): Promise<Record<string, unknown>>;
    read(opts?: { pattern?: string; limit?: number; includeStatic?: boolean; afterSequence?: number; }): Promise<{ cursor: number; entries: Array<unknown>; hasMore: boolean; }>; // Cursor-paged read: pass `afterSequence` from the previous result to get only new requests. Returns network rows only; endpoint candidates come from the explicit `recon.discover(tab)` (not a hidden side effect of reading).
  };
  cookies(domain: string): Promise<Array<unknown>>;
  cookie(name: string, opts?: { domain?: string; }): Promise<string | undefined>; // Read one cookie's value at run time — useful for per-request tokens an adapter needs (csrf/ct0/ csrftoken/XSRF-TOKEN). Defaults to the current page's host. Returns undefined when the cookie is absent.
  fetchJson(url: string, opts?: Record<string, unknown>): Promise<unknown>; // Fetch JSON through the page (its cookies and origin) after verifying the endpoint.
  frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string; crossOrigin?: boolean; oopif?: boolean; }>>;
  download(download: { tab: string; afterSequence: number; started: Array<{ seq: number; guid?: string; url: string; suggestedFilename: string; }>; }, timeoutMs?: number): Promise<DownloadWaitResult>; // Wait for the page download begun after a tab.act cursor, then check Chrome's file state.
}

type Target = ({ frame?: FrameStep | FrameStep[]; within?: string }) & (
  | { ref: number | string }
  | { selector: string; nth?: number }
  | { role?: string; name?: string; label?: string; text?: string; testid?: string; nth?: number }
  | { x: number; y: number });

type FrameStep = string | number;

type ActAction = 'click' | 'dblclick' | 'hover' | 'focus' | 'fill' | 'type' | 'press' | 'select' | 'check' | 'uncheck' | 'upload' | 'drag' | 'scroll' | 'back' | 'forward' | 'reload';

interface ActOptions { target?: Target; action: ActAction; value?: string; files?: string[]; to?: Target; direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; timeoutMs?: number; settleMs?: number; method?: 'cdp' | 'dom' }

interface ActionOutcome {
  action: ActAction;
  delivery: 'applied' | 'received' | 'dispatched';
  controlState: 'verified' | 'unverified';
  network?: { afterSequence: number; cursor: number };
  matches_n?: number;
  navigated?: boolean; url?: string; title?: string; timedOut?: boolean;
  ref?: string; filled?: boolean; verified?: boolean; actual?: string;
  checked?: boolean; changed?: boolean; selected?: string[]; files?: number;
  openedTabs?: Array<{ tab?: string; tabId: number; url?: string; title?: string; pending?: true }>;
  download?: { tab: string; afterSequence: number; started: Array<{ seq: number; guid?: string; url: string; suggestedFilename: string }> }; method?: 'dom';
}

interface ObserveOptions { cursor?: string;
  mode?: 'state' | 'screenshot' | 'both'; format?: 'aria' | 'dom'; frame?: FrameStep | FrameStep[]; since?: string; viewport?: boolean; ref?: string; target?: Target; start?: number;
  limit?: number; includeFrames?: boolean; annotate?: boolean;
  fullPage?: boolean;
}

interface ReadOptions { maxChars?: number; start?: number; readId?: string; frame?: FrameStep | FrameStep[] }

interface ImageValue { __image: true; mimeType: string; base64: string }

interface Box { x: number; y: number; w: number; h: number }

interface FindEntry {
  nth: number;
  ref: string | null;
  selector: string | null;
  tag: string; role: string; name: string; text: string;
  attrs: Record<string, string>;
  visible: boolean; enabled: boolean | null; editable: boolean | null;
  box: Box;
}

interface FindResult { matches_n: number; visible_n: number; selector: string; entries: FindEntry[] }

interface QueryFindResult { matches_n: number; entries: Array<FindEntry & { path: string[]; interactiveAncestorRef: string | null }> }

interface ElementAtResult { matches_n: number; entries: FindEntry[] }

interface ReadTextResult { readId: string; text: string; complete: boolean; reason?: 'budget' | 'scan_limit' | 'unbounded' | 'stale'; chars: number; start: number; nextStart?: number }

interface Expectation { target?: Target; text?: string; notText?: string; url?: string; title?: string; visible?: boolean; value?: string; checked?: boolean; selected?: string[]; enabled?: boolean }

interface CheckResult { ok: boolean; failed: string[]; url: string; title: string; actual?: Record<string, unknown> }

interface DialogInfo { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultPrompt?: string; url?: string; openedAt: number }

interface ConsoleEntry { seq: number; level: 'debug' | 'info' | 'log' | 'warn' | 'error'; message: string; timestamp: string; url?: string; line?: number }

interface CloseUserTabsResult {
  complete: boolean;
  closed: number[];
  failed: Array<{ tabId: number; reason: string }>;
}

interface DownloadWaitResult {
  downloaded: boolean;
  started: boolean;
  sequence?: number;
  suggestedFilename?: string; association?: 'url+event';
  candidates?: number;
  id?: number;
  filename?: string;
  url?: string;
  finalUrl?: string;
  mime?: string;
  totalBytes?: number;
  state?: string;
  danger?: string;
  error?: string;
  elapsedMs: number;
}

type EvaluateOptions = { arg?: unknown; frame?: string | number | Array<string | number> | undefined; timeoutMs?: number | undefined; };

type TabDiscoveryOptions = { query?: string | undefined; limit?: number | undefined; offset?: number | undefined; };

type UserTabInfo = { tabId: number; windowId: number; active: boolean; title?: string | undefined; url?: string | undefined; groupId?: number | undefined; lastAccessed?: number | undefined; lifecycle?: "dormant" | "loading" | "ready" | undefined; availability?: "ready" | "load_required" | "host_attachment_required" | undefined; };

type TabDiscoveryResult = { scope: "unclaimed"; query: string; matching: "case-insensitive-substring"; totalVisible: number; totalInScope: number; excluded: { owned: number; unsupported: number; }; matched: number; offset: number; limit: number; hasMore: boolean; items: Array<{ tabId: number; windowId: number; active: boolean; title?: string | undefined; url?: string | undefined; groupId?: number | undefined; lastAccessed?: number | undefined; lifecycle?: "dormant" | "loading" | "ready" | undefined; availability?: "ready" | "load_required" | "host_attachment_required" | undefined; }>; nextOffset?: number | undefined; };

interface PageTool { name: string; description?: string; inputSchema?: unknown }

interface PageToolsUpdate { status: 'ready' | 'unavailable'; frame: FrameStep[]; tools: Array<{ name: string; description?: string }>; truncated?: boolean }

interface EventStream { read(options?: StreamReadOptions): Promise<StreamBatch>; close(): Promise<void>;
}

interface ObservedContent { metadataTruncated?: boolean; stateContinued?: boolean; stateContinues?: boolean; state?: string; dom?: DomSnapshot; warnings?: string[]; diff?: boolean; changed?: { added: number; removed: number; changed?: number } }

interface ObservedFrame extends ObservedContent { frame: FrameStep[]; owner: FrameOwner; unavailable?: string }

interface ObserveResult extends ObservedContent { scope?: 'viewport' | 'document' | 'target'; complete?: boolean; webmcp?: PageToolsUpdate; nextCursor?: string; next?: { cursor: string };
  url: string | null; title: string | null; snapshotId?: string; image?: ImageValue; frames?: ObservedFrame[]; framesComplete?: boolean;
}

interface DocumentReadResult extends ReadTextResult { next?: ReadOptions }

interface ReadElementOptions { target: Target }

interface DomEntry { ref: string; tag: string; text: string; attrs: Record<string, string>; truncated: boolean }

interface DomSnapshot { entries: DomEntry[]; total: number; start: number; nextStart?: number; scope: 'viewport' | 'document'; next?: { format: 'dom'; frame?: FrameStep[]; target?: Target; start: number; limit?: number; viewport: boolean; includeFrames: false } }

interface FrameOwner { ref: string; id: string; name: string; src: string }

interface ElementDetails { ref: string; tag: string; name: string; text: string; attrs: Record<string, string> }

interface StreamReadOptions { cursor?: string; limit?: number; levels?: string[]; filter?: string }

interface StreamOptions { capacity?: number; args?: unknown[] }

interface StreamEntry { seq: number; timestamp: string; event?: string; args?: unknown[]; params?: unknown; level?: string; message?: string; url?: string; line?: number; truncated?: boolean }

interface StreamBatch { entries: StreamEntry[]; cursor: string; hasMore: boolean; dropped: number; reset: boolean; closed?: boolean; reason?: string }

interface ToolDefinition {
  site: string;
  name: string;
  description: string;
  access: 'read' | 'write';
  domain?: string;
  result?: { kind: 'rows' | 'value'; description: string; fields?: Record<string, string>; paginated?: boolean };
  args?: Arg[]; func: string;
}

interface DraftExpectation { path?: string; equals?: unknown; minRows?: number }

interface CommandRunResult { ok: true; site: string; name: string; rows?: unknown[]; value?: unknown; nextCursor?: string; elapsedMs: number }

interface CommandRunError { ok: false; site: string; name: string; error: { code: string; message: string; hint?: string; details?: Record<string, unknown> }; elapsedMs: number }

interface EndpointCandidate {
  url: string;
  method: string;
  type: string;
  kind: UrlMatch['kind'];
  queryParams: string[];
  bodyParams: string[];
  evidence: 'network+static' | 'network' | 'static';
  network?: { status?: number; contentType?: string; count: number; requestId?: string };
  sources: Array<{ script: string; line: number; snippet: string }>;
  score: number;
}

interface DiscoverResult {
  pageUrl: string | null;
  scripts: Array<{ url: string; bytes: number; analyzed: boolean; error?: string }>;
  endpoints: EndpointCandidate[];
  networkEntries: number;
}

interface UrlMatch {
  url: string;
  method: string;
  type: string;
  queryParams: string[];
  bodyParams: string[];
  headers?: Record<string, string>;
  contentType?: string;
  kind: 'api' | 'asset' | 'page' | 'unknown';
  line: number;
  source: string;
  filename?: string;
}

interface ArgValue {
  type?: 'string' | 'int' | 'number' | 'boolean' | 'array' | 'object';
  nullable?: boolean;
  choices?: Array<string | number | boolean>;
  items?: ArgValue;
  properties?: Record<string, ArgValue & { required?: boolean; help?: string }>;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number; example?: unknown;
}

interface Arg extends ArgValue { name: string;
  required?: boolean;
  default?: unknown; help?: string;
}
```
