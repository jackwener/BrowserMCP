/** Backend-specific instructions: never send an embedded client through Chrome setup. */
export const EMBEDDED_DOCS: Record<string, string> = {
  instructions: `# Embedded BrowserMCP
Use js as a persistent workspace. Pre-bound: browser, sites, tools, recon, agent, session, nodeRepl.
The host application owns pages, workspace/profile selection, login sessions, and storage. No setup or extension installation is needed.
Open or claim a registered tab, observe, act, and verify the actual result. Await API calls. Copy refs from current observations.
Use browser.chrome.describe(method) before a Chrome API call: this backend implements a subset with explicit Electron semantics.
Use tab.cdp.send for page-scoped Chromium protocol operations. Browser-wide Target/Browser commands are not available.
Create and update adapters with tools.define, tools.try and tools.activate. A draft is inactive until verified and activated. Existing adapter code remains shared; execution follows the calling session's profile.
Finish with session_finalize. Borrowed user tabs stay open. Keep deliverables explicitly; handoff pages stay owned until the session closes.
js_reset stops the REPL but already dispatched operations can still finish. Inspect doctor and the page before retrying a mutation.
The host opted into trusted Node execution: REPL and adapter code are not a security sandbox.
Read docs_get for API signatures and recovery guidance.`,
  'capabilities/chrome': `# Chrome API compatibility in Electron
browser.chrome.call(method, argsArray), describe(member), and watch(event, options) are available.
Supported calls: tabs.query/get/create/update/remove/reload; cookies.getAll/get/set/remove.
Supported events: tabs.onCreated/onUpdated/onRemoved/onActivated. Events cover this session's registered pages; activation requires a host callback.
Use describe for positional argument names, semantics and availability. Unimplemented methods/options fail with capability_unavailable.
Only registered tabs in the authorized workspace/profile are visible; another session's owned pages are excluded. Tab ids are Electron webContents ids. windowId is -1 because application tab/window layout is host-owned.
Cookies use the authorized Electron Session. Unsupported Chrome fields such as storeId and partitionKey are rejected.
Use browser.tabs.new and browser.user.claimTab when you need a Tab handle. A raw Chrome call returns a Chrome-shaped value, not a Tab.
A watch handle supports read({cursor,limit}) and close(). Reads report dropped/reset information. js_reset and session finalization release subscriptions.
Extension installation, Native Messaging, Chrome profiles, tabGroups and extension service workers are not involved.`,
  troubleshooting: `# Embedded recovery
Run doctor for runtime and JavaScript state. The host application supplies the backend; do not run CLI setup or install an extension.
page_unavailable/stale_page: the page closed or access was released. List or claim an authorized page and recreate the handle.
debugger_in_use: another debugger owns the target. Ask the host to release it; do not steal its attachment.
profile_mismatch: the host supplied a webContents from the wrong Electron Session. This requires a host integration fix.
capability_unavailable: inspect browser.chrome.describe or browser.capabilities.list; do not assume every Chrome API is implemented.
command_outcome_unknown: inspect current page/site state before repeating a write.
cleanup_failed: the host could not close an owned page. Retry service cleanup after correcting the host callback.`,
};
