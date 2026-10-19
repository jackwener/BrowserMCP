## Define a site adapter

A site adapter is a host-side JavaScript function that uses the same `Tab` API as `js`. It receives `{ tab, args, sites, recon }` and operates its own background tab in the connected Chrome profile. Browser actions, network reads, and `tab.fetchJson()` use the user's existing login.

The optional `domain` is metadata for discovery and the tool icon. It does not navigate the tab; the adapter should call `tab.goto()` when it needs a site origin.

1. Explore the site with `tab.observe()` and `tab.act()`. The action result's `network.afterSequence` is the cursor before that action; use it with `tab.network.list()` (then `tab.network.detail({seq})`) in `js` to inspect requests observed during and after the action. This time window is evidence, not proof that every request was caused by the action. `recon.discover(tab)` ranks observed requests; pass `{includeStatic:true}` only when the captured traffic is insufficient.
2. Verify the endpoint or UI workflow, including authentication, arguments, pagination, and errors. Recompute CSRF tokens and request signatures at run time; never save a captured credential or one-time value.
3. Define an inactive draft with `await tools.define({site,name,description,access,domain?,args?,func})` in `js`. `func` is a function or source such as `async ({tab,args,sites,recon}) => {...}`. The function is saved as source: it cannot capture REPL variables. Args support nested array/object types, nullable, bounds, choices and examples; the contract powers discovery and execution.
4. Run `await tools.try(draft.draftId, sampleArgs, {path:"value.id"})` with real sample args and an assertion. Use `equals` for an exact value or `minRows` for rows. The trial runs independently of REPL bindings. Inspect its result and verification. A write draft may perform the write during this trial.
5. After a passing trial, call `await tools.activate(draft.draftId)`. It atomically replaces the active adapter under `~/.browsermcp/adapters/<site>/<name>.js`; `site_run` can then execute it. For a typed `<site>_<name>` tool, call `await sites.enable(site)` (`write:true` for write commands).

A draft never replaces the current adapter until activation. Activation fails if that adapter changed since the draft was created; create a new draft against the latest version.
Discard an unused draft with `await tools.discard(draftId)` in `js`.

For a logged-in JSON API, navigate to the site's origin before fetching. A minimal function looks like this:

```js
async ({ tab, args }) => {
  await tab.goto('https://example.com/');
  return await tab.fetchJson(`/api/search?q=${encodeURIComponent(args.query)}`);
}
```

Use stable semantic targets and `tab.expect()` when the adapter must interact with the UI. `await tools.list()` and `await tools.remove(site, name)` manage user-defined adapters. Built-in adapters and user adapters use the same loader; a user adapter with the same site and name takes precedence. If writing an adapter file directly, import `defineAdapter` and `errors` from `@jackwener/browsermcp/adapter-sdk`; this SDK is part of the main package.
