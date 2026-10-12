## Native browser capabilities

`js` is the host Node REPL. `browser.chrome` runs Chrome APIs in this extension's service worker. `tab.evaluate` runs JavaScript in page Main World. `tab.cdp` controls one explicit Tab's shared debugger. No imports or repository files are required.

```js
let tabs = await browser.chrome.call('tabs.query', [{}]);
let counts = {};
for (let t of tabs) counts[t.windowId] = (counts[t.windowId] ?? 0) + 1;
nodeRepl.write({total: tabs.length, byWindow: counts});
```

`call(method, argsArray)` takes native positional JSON arguments and returns native data (`null` for no return value). Preserve large results in REPL bindings. Queries do not claim tabs or attach the debugger. `await browser.chrome.describe('tabs.query')` gives signatures generated from pinned `@types/chrome`, parameter fields, official documentation links, declared/granted permissions and runtime member presence. Presence is not proof a call will succeed: Chrome enforces actual permissions, context and arguments. Methods missing from the local reference can still be called. Callback-only methods in the reference are invoked once through an adapter; unknown callback-only APIs, functions, Ports and synchronous-response events are outside this JSON interface. Use `tab.evaluate` for page functions and `tab.cdp` for debugger operations.

Tabs created by `tabs.create`, `tabs.duplicate` and `windows.create` belong to this session. Their original Chrome IDs work with `await browser.tabs.get(String(created.id))`. Moving an existing tab into a window does not adopt it. Popups observed from a claimed tab during a Main World script or CDP command also enter its session. Raw calls preserve explicit focus/mute/window/group settings. Finalize closes agent-created tabs unless kept; claimed user tabs are released. Chrome methods can act directly on existing numeric tab IDs without claiming them.

### Organize tabs and groups

Use native numeric `tab.id`, `group.id`, and `windowId` from query results, not session handles. These operations do not require claiming tabs or observing pages. Keep full inventories in REPL variables and return only the summary needed for the next decision.

| Intent | Native call |
| --- | --- |
| List groups / read one | `tabGroups.query({})` / `tabGroups.get(groupId)` |
| Read group members | `tabs.query({groupId})` |
| Create a group / add members | `tabs.group({tabIds})` / `tabs.group({groupId, tabIds})` |
| Rename, recolor, collapse or expand | `tabGroups.update(groupId, {title, color, collapsed})` |
| Move a group | `tabGroups.move(groupId, {index, windowId})` |
| Dissolve a group, keeping tabs | Query members, then `tabs.ungroup(tabIds)` |
| Close a group's tabs | Query members, then `tabs.remove(tabIds)` |

There is no `tabGroups.create` or `tabGroups.remove`. Group existing tabs by `windowId` before grouping unless a window transfer is intended. For moves, omit `windowId` to reorder locally; use `index: -1` for the end of the window. Chrome only supports group transfers between normal windows. Saved-group reopening, saving and sharing are not exposed by these methods; a readable `shared` property is not a sharing operation.

```js
let selectedTabs = await browser.chrome.call('tabs.query', [{windowId, url: 'https://docs.example.com/*'}]);
let tabIds = selectedTabs.map(t => t.id);
// windowId is from a prior query; only proceed with a non-empty selection.
let groupId = await browser.chrome.call('tabs.group', [{tabIds}]);
await browser.chrome.call('tabGroups.update', [groupId, {title: 'Research', color: 'blue'}]);
await browser.chrome.call('tabGroups.get', [groupId]);
```

Each call is a separate operation: if updating the title fails after creation, `groupId` still identifies the created group. Inspect it and retry the failed step; do not recreate the group or claim the entire task succeeded. `describe` includes `resultFields` for object results (or array items), alongside parameter fields.

Session groups are temporary workspaces. Successfully updating/moving a group, or explicitly grouping tabs into it, relinquishes any session's automatic management of that group: `nameSession` and subsequent new tabs will not change it. Release only ungroups tabs still in a managed workspace; user-arranged groups remain intact. This does **not** change tab ownership: agent-created tabs still need `release()` or a finalize `keep` entry to survive cleanup. Existing user tabs do not need a keep entry. Grouping, pinning and moving do not change the mute policy. Raw-created tabs keep their native mute state; on session-created tabs only an explicit `tabs.update` with `muted` overrides automatic unmuting.

### Events and logs

```js
let events = await browser.chrome.watch('tabs.onUpdated', {capacity: 500});
// listener is registered; now perform the operation
let result = await events.read({limit: 30});
await events.close();
```

`watch(event, {capacity, args})` accepts optional Chrome addListener filter arguments after the listener. Notification events only: no response callback, Port or blocking listener. CDP event subscriptions use `tab.cdp.watch`; independent page console capture uses `tab.console.watch()`, and extension-log capture uses `browser.logs.watch()`. These handles share `read({cursor?,limit?,levels?,filter?})` and `close()`. A handle remembers its cursor; an explicit cursor can reread retained history. Filtering advances past nonmatching records. Start watching before the action; historical events cannot be recovered.

Results include `entries`, opaque `cursor`, `hasMore`, `dropped`, and `reset`. `dropped` counts lost raw records, not lost filter matches. Entries over the payload budget include `truncated:true`. Buffers are bounded by count and size. `closed/reason` signals a detached target or a lost subscription. A service-worker restart loses buffers/subscriptions: a missing subscription reports reset/closed and must be recreated. This is not durable logging.

`tab.console.read(options)` reads the automatic console buffer captured while attached. `browser.logs.read(options)` reads this extension's own service-worker logs, not arbitrary other extensions. Pass returned cursors explicitly for these direct reads. A generation change reports `reset:true`.

Explicit subscriptions survive ordinary MCP calls, but close on `close()`, `js_reset`, REPL termination or session finalization. Reset waits for already dispatched work before removing its subscriptions; inspect `doctor.javascript` for draining work or `cleanupError` if cleanup failed. Automatic console capture remains owned by the debugger runtime.
