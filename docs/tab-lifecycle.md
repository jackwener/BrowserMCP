## Tab lifecycle

Use these methods in `js`, awaiting every call. Start with `await browser.nameSession('🔎 Research')`, then `let tab = await browser.tabs.new(url)`. Agent-created tabs open in a named Chrome group, in the background, muted until the user looks at them.

To use an existing tab, call `await browser.user.openTabs({query:'…',limit:20})`, then `let tab = await browser.user.claimTab({tabId})`. Discovery is recency-sorted, defaults to 20 matches and is capped at 100; it is not a complete browser inventory. To claim the foreground tab, use `{active:true}`. Unique URL/title lookup is also supported; `expectedUrl` and `expectedTitle` check exact identity when necessary. Claiming alone does not observe the page. Claimed user tabs stay outside the agent group and are never closed by finalize.

`await browser.tabs.list()` returns controlled tabs with string `id`, numeric Chrome `tabId`, `origin` and `state`. Obtain a handle with `await browser.tabs.get(id)`. The page id is stable across navigation and becomes stale after closure. An older extension may return `pending:true` without an id; match its numeric `tabId` on a later list call. Unknown ids are rejected rather than adopted.

`await tab.release()` keeps the tab open and gives up control; an agent-created tab leaves only its temporary session group and is unmuted unless its mute state is native (a raw-created tab or an explicit `tabs.update({muted})` call). User-arranged groups are preserved. `await tab.close()` closes a controlled tab. For bulk user-tab cleanup, use `await browser.user.closeTabs([tabId1,tabId2])` without claiming; its result reports `closed` and `failed` ids. Keep discovery and planning in REPL variables, and return a summary before the next decision. Do not move every row into the conversation.

Finish with the MCP tool `session_finalize`, or `await browser.tabs.finalize({keep:[{tab,status:'deliverable'}]})` in `js`. `deliverable` tabs leave temporary session groups and stay open; explicitly arranged groups are preserved; `handoff` tabs stay grouped for a later turn; other agent tabs close. Failed tabs retain their lease for retry. After successful finalize, old handles are released; obtain fresh handles in a later turn. Let running JavaScript finish before calling the separate finalize tool.

Resetting JavaScript leaves browser tabs open. Closing the MCP client closes its local IPC connection and finalizes only that connection’s session. A host restart creates a new session; `session_restarted` means rebuild REPL bindings and inspect the browser before continuing. An idle browser session is finalized after an hour.

For grouping, renaming, moving, pinning and window organization, use `browser.chrome.call` without claiming tabs. Read `capabilities/chrome` for the task-to-method map and complete group workflow. Grouping does not automatically keep agent-created tabs.
