/** Backend-specific instructions: never send an embedded client through Chrome setup. */
export const EMBEDDED_DOCS: Record<string, string> = {
  instructions: `# Embedded BrowserMCP
Use existing site adapters for matching site tasks: sites_search finds commands and arguments; site_run executes them directly. No enabling step is needed. Use js as a persistent workspace for tasks not covered by an adapter. Pre-bound: helper, browser, sites, tools, recon, agent, session, nodeRepl.
Bundled adapters are available by default; the host may override sources or pass [] to load only application-created adapters. New adapters are stored under the application dataDir/adapters, never a global home directory.
The host application owns pages, workspace/profile selection, login sessions, and storage. No setup or extension installation is needed.
Registered tabs can be dormant; listing them does not load them. claimTab loads a dormant tab before returning. active reflects the host-selected tab, not keyboard focus.
Use tabs_list to discover and reuse a session tab, or claim_tab to acquire a registered tab. navigate_tab changes its URL in place; only open_tab creates a new page. close_tab closes an explicit session tab; release_tab leaves it open. tab_observe and tab_act use the same tabId. All these commands are available with identical schemas through helper in js and session.api.helper in the host. Observe, act, and verify the actual result. Await API calls. Copy refs from current observations.
Use browser.chrome.describe(method) before a Chrome API call: this backend implements a subset with explicit Electron semantics.
Use tab.cdp.send for page-scoped Chromium protocol operations. Browser-wide Target/Browser commands are not available.
Create and update adapters with tools.define, tools.try and tools.activate. A draft is inactive until verified and activated. Existing adapter code remains shared; execution follows the calling session's profile.
Finish with session_finish. Borrowed user tabs stay open. Use await tab.markDeliverable() for results and await tab.markHandoff() for later work; clearRetention() removes a mark. Full tab.id is required in explicit keep entries; invalid entries abort all cleanup. WebContents replacement preserves logical tab identity, ownership and marks. Read URLs with await tab.url(); list rows have URL snapshot fields. Keep deliverables explicitly; handoff pages keep usable handles until the session closes. Cleanup returns closed, released, retained and failed separately.
js_reset stops the REPL but already dispatched operations can still finish. Inspect doctor and the page before retrying a mutation.
The host opted into trusted Node execution: REPL and adapter code are not a security sandbox.
Read docs_get for API signatures and recovery guidance.`,
  'capabilities/chrome': `# Chrome API compatibility in Electron
browser.chrome.call(method, argsArray), describe(member), and watch(event, options) are available.
Supported calls: tabs.query/get/create/update/remove/reload; cookies.getAll/get/set/remove.
Supported events: tabs.onCreated/onUpdated/onRemoved/onActivated. Events cover this session's registered pages; activation requires a host callback.
Use describe for positional argument names, semantics and availability. Unimplemented methods/options fail with capability_unavailable.
Only registered tabs in the authorized workspace/profile are visible; another session's owned pages are excluded. Tab ids are stable BrowserMCP logical identities, not Electron webContents ids. windowId is -1 because application tab/window layout is host-owned.
Cookies use the authorized Electron Session. Unsupported Chrome fields such as storeId and partitionKey are rejected.
Use browser.tabs.new and browser.user.claimTab when you need a Tab handle. A raw Chrome call returns a Chrome-shaped value, not a Tab.
A watch handle supports read({cursor,limit}) and close(). Reads report dropped/reset information. js_reset and session finalization release subscriptions.
Extension installation, Native Messaging, Chrome profiles, tabGroups and extension service workers are not involved.`,
  troubleshooting: `# Embedded recovery
Run doctor for runtime and JavaScript state. The host application supplies the backend; do not run CLI setup or install an extension.
tab_not_found: no registered tab matches. List browser.user.openTabs and use a reported tabId; active selection must be supplied by the host.
invalid_tab_id: malformed handle; use the full tab.id, not a variable name or numeric tabId.
page_released: claim the same tab again. tab_closed: the logical tab was removed. already_claimed: another session owns it. page_unavailable: the id is unknown or outside this session scope.
page_not_ready/stale_page: the host must restore or attach a live execution resource for this logical tab.
host_callback_failed/host_contract_violation: inspect the reported phase and tab state; correct the host callback.
load_cancelled/tab_load_timeout: loading was revoked or exceeded its deadline; inspect current ownership before retrying.
debugger_in_use: another debugger owns the target. Ask the host to release it; do not steal its attachment.
profile_mismatch: the host supplied a webContents from the wrong Electron Session. This requires a host integration fix.
capability_unavailable: inspect browser.chrome.describe or browser.capabilities.list; do not assume every Chrome API is implemented.
command_outcome_unknown: inspect current page/site state before repeating a write.
cleanup_failed: the host could not close an owned page. Retry service cleanup after correcting the host callback.`,
};
