# BrowserMCP

**A browser service for MCP agents, connected to the Chrome you're already logged into.**

BrowserMCP lets MCP clients observe and operate your Chrome tabs through a local extension and host. Optional site adapters package verified workflows as reusable tools.

[![npm](https://img.shields.io/npm/v/@jackwener/browsermcp)](https://www.npmjs.com/package/@jackwener/browsermcp)
[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-Install_extension-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/browsermcp-connector/lnaoghmfcdnbhgcihkakfobckmfhllkg)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933)](package.json)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

[Quick start](#quick-start) · [Usage](#usage) · [Documentation](#documentation) · [中文指南](docs/guide.zh-CN.md)

## What you can do

- **Work with logged-in websites.** Search, read pages, fill forms, and navigate through your existing browser session.
- **Use optional site commands.** Discover built-in adapters for Twitter/X, Bilibili, and Reddit when a site-specific command helps.
- **Add site adapters.** Inspect a site's requests, verify an API, and define an explicit reusable MCP tool.
- **Keep browser work organized.** Agent-created tabs live in named groups and are cleaned up after use. Tabs borrowed from the user are never closed by session cleanup.

Works with MCP clients including Claude Code, Codex, OpenCode, Cursor, Claude Desktop, DeepSeek Harness (`dsh`), and Pi (with `pi-mcp-adapter`). Agents use a persistent JavaScript REPL for browser work and structured site tools for verified workflows.

The npm package is `@jackwener/browsermcp`; the command is `browsermcp`.

## Quick start

You need **Node.js 22 or newer**, **Google Chrome**, and an **MCP client**. The local host also supports Chromium-based browsers such as Edge and Brave; see [installation details](docs/setup.md).

### 1. Install the Chrome extension

[**Install BrowserMCP Connector from the Chrome Web Store →**](https://chromewebstore.google.com/detail/browsermcp-connector/lnaoghmfcdnbhgcihkakfobckmfhllkg)

For an extension version ahead of the Web Store, download the **manual-install zip** from [GitHub Releases](https://github.com/jackwener/browsermcp/releases) and follow the [manual installation steps](docs/setup.md#manual-extension-installation).

### 2. Install the npm package and set up the connection

```bash
npm install -g @jackwener/browsermcp
browsermcp setup
```

Keep Chrome open. `setup` connects the extension to the local program, asks which MCP clients to configure, registers only your selection, and checks the browser connection. If you have not installed the extension yet, it opens the Chrome Web Store for you.

For **Cursor, Claude Desktop, and other MCP clients**, choose `manual` and copy the configuration printed by `setup` into your client's MCP settings. It uses absolute paths so desktop apps can find the program.

For **OpenCode**, run `browsermcp setup --clients opencode`. It adds a global MCP entry while preserving your other settings.

For **DeepSeek Harness (`dsh`)**, run `browsermcp setup --clients none`, then add the same npm package to your dsh profile:

```bash
dsh plugin --profile web add @jackwener/browsermcp
```

Restart `dsh web`. The package's dsh bundle uses dsh's MCP client to connect to the browser service. See the [dsh setup details](docs/setup.md#deepseek-harness-dsh).

For **Pi**, install `pi-mcp-adapter`, then run `browsermcp setup --clients pi`. See the [Pi setup steps](docs/setup.md#pi).

### 3. Start using it

Restart or reconnect your MCP client, then ask:

> Use BrowserMCP to read the top five Hacker News stories and summarize them with links.

You can rerun `browsermcp setup` to repair the browser registration or select newly installed clients to configure. Selected clients have their `browsermcp` entry updated to a stable launcher; other server entries are preserved. The launcher follows Homebrew upgrades within the same formula. If Node or the package moves, rerun setup. For a read-only startup and connection check, run `browsermcp doctor`.

Connection issues? See [troubleshooting](docs/setup.md#troubleshooting).

## Local configuration

Data, configuration, and user adapters live in `~/.browsermcp`. The launcher is `~/.browsermcp/bin/browsermcp-launcher` (`.cmd` on Windows). Run `browsermcp setup` to register it with Chrome and your selected MCP clients.

This is a fresh configuration: old directories, environment variables, and adapter import aliases are not used. Remove obsolete MCP client entries manually. User adapters import `@jackwener/browsermcp/adapter-sdk`.

## Usage

Tell your agent what you want to do; it discovers and calls the MCP tools. For example:

- “Open Hacker News, read the newest stories, and keep the most useful page open for me.”
- “Search for site commands that work with Bilibili.”
- “Explore this website's search, then create a reusable tool for the same query workflow.”

For integrations and custom workflows, the main tools are:

| Task | Tools |
|---|---|
| Browser workspace | `js`, `js_reset` |
| Discover and run site commands | `sites_search`, `site_run` |
| Learn the API | `docs_get` (quickstart, topics, or an exact API member) |
| Diagnose connection and execution | `doctor` |
| Finish a browser session | `session_finish` |

The browser workflow is **observe → act → verify → finalize**, expressed in `js` using the same object model as adapters:

```js
let tab = await browser.tabs.new('https://example.com/');
await tab.observe();
```

Variables, functions, classes and Tab handles persist across calls. After inspecting the result, use `await tab.act(...)` and `await tab.expect(...)` or observe again. Keep working data in variables and return only relevant evidence. `docs_get {}` provides a compact quickstart; `{name:"api-reference",member:"Tab.act"}` provides exact types. No repository documentation access is required.

Use `browser.user.openTabs({query,limit})` and `browser.user.claimTab(...)` for user tabs. The lookup returns a discovery envelope: read `items`, `matched`, `totalInScope`, `excluded` and `hasMore`. It returns up to 20 recent matches by default; continue with `offset: nextOffset`. `tab.release()` leaves a tab open; `tab.close()` closes it. `session_finish` closes agent tabs not kept and releases borrowed tabs. `js_reset` stops JavaScript and clears bindings while leaving tabs open; already dispatched operations may still complete. All API methods are awaited.

Inside the `js` tool, you can also call site commands directly:

```js
await sites.enable('reddit');
const posts = await sites.reddit.hot({ subreddit: 'programming', limit: 5 });
posts;
```

See the [JavaScript guide](docs/js-tool.md), [API reference](docs/api-reference.md), and [tool authoring guide](docs/define-tools.md) for complete examples.

## How it works

```text
MCP client → browsermcp launcher → local host ⇄ Chrome extension → website
                stdio              Native Messaging             your session
```

Chrome starts the local host through Native Messaging. The extension operates browser tabs using Chrome's debugger APIs and Playwright's injected locator engine. The host exposes browser operations, site commands, and tool authoring through MCP.
Each MCP client connection has its own tab and JavaScript session, so one client's cleanup does not close another client's tabs.

The MCP launcher can start before Chrome. It keeps the client connection open and reconnects when the Chrome-owned host appears or restarts. Browser operations and site adapters use that host; run `browsermcp doctor` if it stays unavailable.

Connections are local-only: standard MCP stdio to the launcher, then Unix domain socket (macOS/Linux) or named pipe (Windows) to the host. No port or token configuration. See [browser selection and configuration](docs/setup.md#local-connections-and-browser-selection).

## Browser access and permissions

The extension requests browser permissions including `debugger`, `cookies`, and access to all URLs so it can operate logged-in sites. Connected agents can act with the access available in your browser session.

Site commands execute directly without additional approval prompts. The read/write classification describes their effects. See [configuration](docs/setup.md#configuration).

## Documentation

| Guide | Contents |
|---|---|
| [Installation and configuration](docs/setup.md) | Source installs, browser profiles, local connections, settings, troubleshooting |
| [中文指南](docs/guide.zh-CN.md) | Chinese project overview and detailed usage |
| [Site commands](docs/sites.md) | Discovering, enabling, and running adapters |
| [JavaScript guide](docs/js-tool.md) | Persistent sessions and the object API |
| [API reference](docs/api-reference.md) | Generated reference for browser and tool APIs |
| [Creating tools](docs/define-tools.md) | Define and verify reusable site adapters |
| [Tab lifecycle](docs/tab-lifecycle.md) | Claiming tabs, grouping, and cleanup |
| [Errors](docs/errors.md) | Error codes and recovery |

## Embedded Electron applications

Import `@jackwener/browsermcp/embedded` from Electron's main process. This entry does not run setup, register Native Messaging, discover Chrome, read global CLI configuration, or install an extension. The application supplies its writable directory, profile sessions, and page lifecycle callbacks. Adapters can still be created, verified, activated, updated, and removed through `tools`.

```ts
import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import { createEmbeddedBrowser } from '@jackwener/browsermcp/embedded';

await app.whenReady();
const windows = new Map<number, BrowserWindow>();
const profile = ({ profileId }) => session.fromPartition(`persist:${profileId}`);
const browser = await createEmbeddedBrowser({
  dataDir: path.join(app.getPath('userData'), 'browsermcp'),
  execution: 'trusted-node',
  browser: {
    profile,
    async createPage(scope) {
      const window = new BrowserWindow({
        webPreferences: {
          session: profile(scope), contextIsolation: true,
          sandbox: true, nodeIntegration: false,
        },
      });
      const id = window.webContents.id;
      windows.set(id, window);
      window.once('closed', () => windows.delete(id));
      return { contents: window.webContents, close: async () => { window.destroy(); } };
    },
    async activatePage(contents) { windows.get(contents.id)?.show(); },
  },
});

// Scope comes from the application, not from agent-provided MCP arguments.
const connection = browser.createSession({ workspaceId: 'project-a', profileId: 'personal' });
await connection.server.connect(transport); // Any host-provided MCP SDK transport.
// On disconnect, cleanup is automatic. Explicit close and application shutdown:
await connection.close();
await browser.dispose();
```

The host owns logical tabs; a tab does not need a `WebContents` until it is claimed. Register restored tabs immediately, and synchronize selection from the host UI:

```ts
const scope = { workspaceId: 'workspace', profileId: 'personal' };
const handle = browser.registerPage({
  scope,
  url: restoredTab.url,
  title: restoredTab.title,
  load: async (signal) => {
    // Resolve only once the restored tab has loaded; honor cancellation.
    return hostTabs.ensureLoaded(restoredTab.id, { signal });
  },
  close: async () => { await hostTabs.close(restoredTab.id); },
});
browser.setActivePage(scope, handle); // Call on each host selection change.
browser.updatePage(handle, { url: restoredTab.url, title: restoredTab.title });
const unsubscribe = browser.subscribe((event) => {
  // event.sessionId matches createSession().id, with no internal prefix.
  // event.page.sessionId is the current owner; undefined after release.
  hostTabs.setAgentOwner(event.page.handle, event.page.sessionId);
});
const snapshot = browser.getPages(scope); // Initialize/reconcile host UI.
```

`registerPage` takes a descriptor with `scope`, `url`, optional `title` / `contents` / `load(signal)`, and a required `close()` callback. For restored tabs, pass metadata and `load(signal)`; enumeration and matching do not trigger loading. A claim reserves exclusive ownership before loading, validates the resolved Electron profile, and returns only after loading succeeds. Failed loads return an unowned tab to the pool. Loading is cancelled on release, unregister, or session cleanup, and is bounded to 30 seconds. A host must honor the signal to prevent its own late side effects; BrowserMCP never attaches a result after access is revoked. WebContents destruction detaches the execution resource; the logical tab, ownership and retention remain intact. Use `attachPage(handle, contents)` to attach a replacement, or let `load(signal)` restore it on demand. `detachPage(handle)` explicitly detaches a resource. `close()` must close the logical host tab, including dormant tabs and tabs whose WebContents was replaced; bind it to the host tab identity, not an obsolete WebContents. Call `unregisterPage(handle)` when the logical host tab is removed.

**Identity contract:** the returned handle and the numeric `tabId` in `getPages()` / agent tab lists belong to BrowserMCP. `tabId` is not `webContents.id`. Use the handle to map to your host tab and use the reported `tabId` for Chrome-shaped calls. Both stay stable across loading and WebContents replacement. `webContentsId` identifies only the current execution resource. This changes the implicit `webContents.id` behavior in `0.0.34-embedded.0` and the original vendored branch.

`setActivePage(scope, handle | null)` is authoritative; keyboard focus is never used to infer the selected tab. Each workspace/profile has at most one active tab. `openTabs`, `claimTab({ active: true })`, owned-tab lists and `chrome.tabs.query` read the same registry state. `activatePage(contents)` implements agent-requested activation, after which the registry selection is updated. A zero-match claim reports `tab_not_found`; multiple matches report `ambiguous_tab`.

Host `subscribe()` emits typed snapshots for registration, metadata/lifecycle changes, activation, acquisition, release, navigation, closure and unregister. Acquisition is idempotent for the same session. Listener exceptions cannot break ownership transitions. Subscribe before taking `getPages(scope)` when initializing UI, and unsubscribe when disposing it. MCP version defaults to the installed BrowserMCP package version; explicit `version` remains available for bundled hosts.

The callbacks can manage `WebContentsView` instead of `BrowserWindow`; layout is entirely application-owned. Use `browser.registerPage({ scope, url, contents, close })` to make an existing user page available for claiming. Register only intended browser content, not application settings or privileged UI. `unregisterPage(handle)` revokes access without closing the page. User pages are released during cleanup; unkept agent pages are closed. Profile IDs must map to the intended Electron `Session`, and the backend checks this identity when registering/creating pages.

The current evaluator explicitly requires **trusted Node execution**. REPL and adapter modules can access Node capabilities; neither `vm`, a Worker, nor page registration is a sandbox against malicious host code. The REPL runs in a Worker; adapter modules execute in the runtime process. This main-process entry is for applications that trust the connected agent and loaded adapter code. Browser pages should retain `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`.

Storage is confined by configuration: generated adapters are in `<dataDir>/adapters`, inactive candidates in `<dataDir>/drafts`, and a small standalone adapter SDK in `<dataDir>/node_modules`. No implicit `~/.browsermcp` or `~/.opencli-mcp` source is loaded. Built-in adapters load by default. Set `sources` to replace the read-only sources, or `sources: []` to use only application-owned adapters. Activated adapters in `<dataDir>/adapters` override these sources and become available to existing sessions immediately through `sites_search` and `site_run`. Files copied into that directory externally are loaded on restart. Adapter code is shared within the service, while execution uses the caller's authorized profile and pages. No login credentials are copied between profiles.

`browser.chrome.call/describe/watch` remain available. Electron implements `tabs.query/get/create/update/remove/reload` and `cookies.getAll/get/set/remove`, plus session-scoped `tabs.onCreated/onUpdated/onRemoved/onActivated` events. Call `describe` for method availability and differences. Only registered, accessible tabs are returned; `windowId` is `-1` because window organization belongs to the host. Unsupported methods/options return `capability_unavailable`. Page-scoped CDP is available through `tab.cdp.send`; browser-wide `Target.*` and `Browser.*` commands are rejected. This is an explicit compatibility surface, not an emulation of every extension API.

Package the generated `dist`, `docs`, `adapters`, and `adapter-sdk` resources with the npm package. When using ASAR, unpack `**/js-*.mjs` so the REPL worker and evaluator remain loadable. Keep Electron as an application dependency; it is only a development dependency here. Call `dispose()` before quitting, await it, and handle cleanup failures; it is safe to retry. The SDK does not install process exit handlers or call `process.exit()`.

Validation:

```bash
npm run build:embedded        # SDK and page resources; no extension build required
npm run smoke:embedded        # real Electron + MCP, two profiles, adapter editing, cleanup
npm run smoke:embedded:package # installed npm package inside app.asar
```

## Development

```bash
git clone https://github.com/jackwener/browsermcp.git browsermcp
cd browsermcp
npm install
npm run typecheck
```

`npm install` builds the project through its `prepare` script. To connect a development build to Chrome, follow [the unpacked-extension instructions](docs/setup.md#from-source).

```bash
npm run build:ext        # rebuild the extension
npm test                 # core regression tests
npm run smoke:setup      # isolated setup and Native Messaging end-to-end check
npm run smoke:browser    # end-to-end check with a connected Chrome extension
```

Keep the automated suite focused on MCP browser flow, REPL persistence and interruption, connection recovery, session isolation, tab cleanup, and adapter execution. Prefer these integration checks over per-adapter mapping tests and implementation-detail assertions. Run the tests relevant to your change. `npm run check` runs typecheck, build, and the full test suite when a broader check is needed. For browser changes, use the browser smoke test. `docs/api-reference.md` is generated during the build; update its TypeScript source rather than editing the generated file.

Maintainers: use the [release workflow](docs/releasing.md) to publish the npm package and GitHub Release.

Found a bug or have a feature request? [Open an issue](https://github.com/jackwener/browsermcp/issues). See [CHANGELOG.md](CHANGELOG.md) for release history.

## License and credits

[Apache-2.0](LICENSE). Some browser helpers and adapters were adapted from [OpenCLI](https://github.com/jackwener/OpenCLI); no OpenCLI dependency or compatibility layer is required. Uses [Playwright](https://github.com/microsoft/playwright)'s injected locator engine. Endpoint analysis is inspired by [jsluice](https://github.com/BishopFox/jsluice).

### Native browser APIs

The REPL also exposes `browser.chrome.call(method, argsArray)` for native Chrome APIs, `tab.cdp.send(method, params)` for an explicit Tab, and writable Main World `tab.evaluate(script, {arg, timeoutMs})`. Use `browser.chrome.describe("tabs.query")` for on-demand signatures and runtime availability. Chrome/CDP events and page/extension logs support bounded subscriptions with explicit loss/reset information. Read `docs_get {name:"capabilities/chrome"}` inside MCP for examples and lifecycle rules, or [the native capabilities guide](docs/capabilities/chrome.md).

For development, `npm run smoke:native` runs the new flows in a disposable Chromium profile after a build. Set `BROWSERMCP_SMOKE_CHROME` to a Chromium executable when it is not available in the local Playwright cache. It does not modify the everyday browser profile or native-host registration.

### Common browser tools

Use `tabs_list` → `claim_tab` to reuse an existing page, then `navigate_tab`, `tab_observe` and `tab_act`. Only `open_tab` creates a new page. `close_tab`/`tabs_close` close explicit session tabs; `release_tab` leaves a tab open. `session_finish` reports closed, released, retained and failed tabs separately. Handoff tabs remain usable in the same session.

The persistent `js` workspace exposes the same commands through `helper`, including `helper.navigate_tab({tabId,url})` and `helper.close_tab({tabId})`. Chrome APIs, CDP and Adapter authoring remain available through the existing object API.
