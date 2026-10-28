# BrowserMCP

Use typed tools for common browser operations and `js` for batching, page scripts, Chrome APIs and adapters. Start with `tabs_list`; reuse a session `tabId`, or `claim_tab` an existing `backendId` (or `{active:true}`). `navigate_tab` navigates that tab in place. Only `open_tab` explicitly creates a new tab. `close_tab` closes it; `release_tab` leaves it open and relinquishes control.

Every typed browser command is also available as `helper.<tool_name>(input)` in `js`, with identical arguments and results. Example: `await helper.navigate_tab({tabId: tab.id, url:"https://example.com"})`. Helpers are bound to the calling MCP session.

Use `js` as a persistent browser workspace. Pre-bound: `helper`, `browser` (your logged-in Chrome), `sites`, `tools`, `recon`, `agent`, `session`, and `nodeRepl`. Await API methods; keep Tab handles and working data in variables across calls.

Start with `docs_get {}` for a short quickstart and available topics. For exact signatures, request `docs_get {name:"api-reference",member:"Tab.act"}` (or another class/member). These documents describe the connected runtime; no repository access or imports are needed.

- If a ready-made adapter fits, use `sites_search` then `site_run`. Enabled adapters can also appear as typed site tools.
- Otherwise reuse or claim a tab, then `tab.observe()` → `tab.act(...)` → `tab.expect(...)` or a relevant observation. `tab.read()` reads content; `tab.find()` locates a target in a large action map. Use a ref returned by the current observation.
- If ARIA misses a control, use `tab.observe({format:"dom"})` for visible DOM controls and live values; `tab.read({target:{ref}})` reads exact text/attributes. Refs automatically route to their observed frame. Reuse the same target for read, act and expect. Use a screenshot for visual meaning absent from DOM.
- Browser management uses `browser.chrome.call(method, argsArray)`; inspect signatures with `browser.chrome.describe(member)`. Page scripts use `tab.evaluate`, and Tab-level protocol calls use `tab.cdp.send`. Discover availability through `browser.capabilities.list()`.
- Batch already determined steps and data processing. Return new evidence when the next step needs model judgment. Await every API operation before returning.
- An action's input delivery or control verification does not prove the site's task is complete. Verify the cheapest authoritative result; inspect before retrying uncertain actions.
- Finish with `session_finish`, keeping only deliverable/handoff tabs. `js_reset` clears JavaScript bindings, closes explicit subscriptions and stops its worker; it does not close browser tabs. `doctor` reports connection and JavaScript execution status.
- To create an adapter, read `define-tools`, explore and verify its workflow, then use `tools.define`, `tools.try`, and `tools.activate` in `js`.
