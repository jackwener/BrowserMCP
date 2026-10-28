## Troubleshooting the browser bridge

- `host_unavailable`: the stdio MCP connection stays open, but the Chrome-owned host is not reachable yet. Open Chrome with the extension enabled and retry the same tool call; restarting the MCP client is unnecessary. Run `browsermcp doctor` if it stays unavailable.
- `browser_unavailable`: no extension connected. Run `doctor`. Chrome must be running with the browsermcp extension enabled; the runtime is spawned by Chrome through Native Messaging (`browsermcp setup` configures the browser connection).
- A protocol revision mismatch in `doctor` blocks browser commands before dispatch. Update the host and extension together; their lifecycle response schemas must agree.
- `dialog_open`: a native JavaScript dialog is blocking the tab. `tab.dialog.get()/accept()/dismiss()` (in `js`) read and answer it. `no_dialog`: nothing is pending (dialogs are tracked only while the debugger is attached, so one opened before the first command may need a first `tab.observe` to surface).
- Empty tab lists after finalize are normal. A missing/stale tab does not mean the browser disconnected: open or claim a fresh tab.
