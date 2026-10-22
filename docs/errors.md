## Error codes — branch on `error.code`, never on message text

Every error has `code`, `message`, optional `hint`, and any structured data spread beside them (`candidates`, `details`, `dialog`, `expect`, `failed`, `retryable`). MCP tool errors use this envelope. Inside `js`, caught API errors carry `code`, `message`, `hint`, and structured `data`; an uncaught error is formatted into the MCP envelope.

| family | codes | what to do |
|---|---|---|
| observation | `snapshot_ref_unavailable` | ARIA capture could not establish actionable refs; use `tab.observe({format:"dom"})` for independent DOM evidence |
| locating | `not_found`, `selector_ambiguous` (+`candidates`), `stale_ref`, `invalid_target`, `missing_target` | observe again for fresh refs; scope with `within`, use the `selector` from find; `stale_ref` after navigation |
| actionability | `not_visible`, `not_enabled`, `not_editable`, `not_checkable`, `not_a_select`, `not_a_file_input`, `intercepted` (blocker named), `not_delivered`, `option_not_found` (+`available`), `timeout` | the element exists but cannot take the action; dismiss the blocker, target the real control, or wait with `expect`. `not_delivered`: the mouse event never reached the page. Retry that same target once with `method:"dom"` (HTMLElement.click(), no mouse event) only in that case, or when `not_visible` says the element has no box. A click that already returned ok must not be repeated with `method:"dom"` |
| navigation | `invalid_url`, `page_not_loaded`, `stale_page`, `page_not_in_session`, `page_released`, `tab_create_failed`, `tab_create_cleanup_failed`, `no_tab`, `tab_pending` | the URL was blocked/unreachable, the tab is gone, or finalize handed it back to the user; open or claim a fresh tab. A page handle stays stable during navigation but becomes stale after its tab closes. For `tab_pending`, call `browser.tabs.list()` again and match its numeric `tabId`. If cleanup failed, use `browser.tabs.list()` and `tab.close` on the remaining tab |
| frames | `frame_not_found` (which level is named), `frame_unreachable` | check the chain outermost-first; the frame may still be loading |
| dialogs | `dialog_open` (+`dialog`), `no_dialog`, `dialog_answer_timeout` | read with `tab.dialog.get()`, answer with accept/dismiss, then retry |
| expectations & adapters | `expectation_failed` (+`expect`, `failed`, `state`), `invalid_definition`, `unknown_site`, `unknown_command`, `adapter_load` | inspect the failed expectation or adapter definition |
| adapter drafts | `unknown_draft`, `draft_in_use`, `draft_not_verified`, `draft_changed`, `draft_conflict`, `adapter_result_mismatch` | wait for a running trial, run `tools.try` with a result assertion, or create a new draft from the current adapter; inspect the declared result shape |
| network evidence | `network_entry_not_found`, `capability_unavailable` | call `tab.network.list()` for a current `seq`; inspect `doctor` for extension features |
| document reading | `stale_read` | the saved text capture was replaced or the page navigated; call `tab.read` without `readId` to start a new capture |
| claiming tabs | `claim_not_found`, `claim_ambiguous` (+candidates), `claim_identity_mismatch`, `claim_not_allowed`, `already_claimed` | call `browser.user.openTabs()` and claim by `tabId` |
| ending tabs | `tab_close_failed`, `tab_release_failed` | Chrome refused to close or release the tab; its lease remains active, so retry `tab.close`, `tab.release`, or `session_finalize` |
| host unavailable | `host_unavailable` | Start Chrome and retry. A protocol revision difference is reported by `doctor` as a warning; available browser operations still run |
| browser selection | `browser_selection_required` | Multiple hosts are connected; use `browsermcp doctor --json` and select `browserId` in config |
| session restart | `session_restarted` | The call was not executed. Recreate REPL bindings and Tab handles, then inspect current state before continuing |
| unsupported extension action | `unknown_action`, `capability_unavailable` | The connected extension lacks this specific operation. Inspect `doctor` for its advertised features and protocol warning; update the extension if needed |
| runtime | `browser_unavailable`, `unsupported_backend`, `unknown_browser`, `unknown_capability`, `unknown_doc`, `cancelled`, `command_failed` | run `doctor` when the browser bridge is unavailable; use `tab.act` for ordinary input or `tab.evaluate` for page scripts |
| uncertain outcome | `command_outcome_unknown`, `command_lost`, `result_evicted` | the command may already have applied. Inspect the browser or site state before deciding whether to run it again |

| JavaScript | `js_error`, `js_timeout`, `js_cancelled`, `js_reset`, `js_busy`, `js_worker_failed`, `js_worker_exited` | ordinary exceptions preserve bindings; timeout, cancellation, reset and worker failure clear them. `js_busy`: wait for `doctor` javascript.pendingCalls to reach zero. See `repl-session` for execution and recovery semantics |

Native browser APIs report `chrome_api_unavailable`, `chrome_api_error`, `unsupported_call_shape`, and `runtime_state_conflict`. Inspect `browser.chrome.describe(member)` for context/signatures. Streams report loss/reset in their results; `stream_closed` requires a new watch. `command_outcome_unknown` means dispatched page code may have run: inspect before retrying. `result_not_serializable` requires returning plain data.

## Trustworthy API boundaries

`invalid_args` with `dispatched:false` rejects an invocation before browser effects; fix the indicated field and retry that call. Evaluation does not guess positional arguments or discard unknown options. REPL call transport rejects lossy values rather than applying display formatting to them.

`invalid_response` from tab discovery means a backend response violated the protocol, not that the browser has no tabs. Check `doctor` for host/backend versions. Protocol revision 4 requires the discovery envelope; update host and extension together.

For discovery, `totalInScope:0` means no eligible unclaimed tabs in the visible scope; `totalInScope>0, matched:0` means no literal query match. `excluded` explains ownership and unsupported-page exclusions. `hasMore` distinguishes a partial result from a complete match set. Search emptiness is not an exception.

Issues #18 and #19 exposed different evidence: #18's silent argument loss is reproducible. #19's literal `x.com/home` query matches `https://x.com/home` in the reported version's implementation; its reported live discrepancy is not established by that example alone. The discovery envelope and strict response validation address the confirmed ambiguity without asserting an unverified incident cause.

The design borrows explicit tool contracts from OpenAI's public function-calling guidance (https://developers.openai.com/api/docs/guides/function-calling) and observe/action feedback from the publicly described ChatGPT agent (https://openai.com/index/introducing-chatgpt-agent/). These sources do not disclose ChatGPT's internal tab-search implementation. In this REPL, an MCP schema for the outer `code` string cannot validate nested JavaScript API calls; runtime contracts remain necessary.

### Local client implementation evidence

A read-only inspection of the locally installed ChatGPT.app ASAR on 2026-10-22 found package `openai-codex-electron` version `26.1007.30912`. In `.vite/build/main-CqEoQDOU.js` (SHA-256 `09d19386e1f23cf4ccbc950fc40d85a1e8a064a08be588b2a4be6a89f6ada9e6`), these named methods remain visible in the bundled JavaScript:

- `getTabsForBrowserUse` and `serializeTab`: build inventory from host metadata and optional live runtime, expose stable provider identity and session-control status, and choose an active tab. This layer has no query argument; it does not establish how a separate search API works.
- `requireLiveTab`: recover a missing execution resource only when a concrete tab is needed. Inventory survives WebContents destruction.
- `requireBrowserUseTab`: enforce the session route before access.
- `assertTabMatchesCurrentBrowserUsePage`: check page identity and WebContents identity/liveness before dispatch, including after asynchronous waits.
- `runLoggedRequest`: attach session/request/turn context to failures and rethrow them.

These are observations of the installed desktop bundle, not claims about ChatGPT's server implementation or original source. We independently implement shared discovery contracts and retain host-owned logical tabs. We do not adopt its fallback to the first tab as an indication of the user's foreground intent. No vendor code is included in this repository.

The installed `openai-bundled/browser/26.1007.30912/scripts/browser-client.mjs` provides more direct evidence: `BrowserUser.openTabs()` accepts no query and returns `.tabs`; `PlaywrightAPI.evaluate` takes `(function, arg, options)`. Its argument serializer uses `JSON.stringify`; isolated execution confirmed `NaN` becomes `null` and `{x:undefined}` becomes `{}`. Those are reasons to enforce our own lossless contract, not copy that implementation. The positional signature explains a plausible source of API confusion, but does not establish what happened in either reporter's session.
