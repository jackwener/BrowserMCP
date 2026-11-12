// Real Chromium + chrome.debugger + production page/action code: what an agent is told after it acts and checks.
// Covers: visibility of transparent text, the effect of an action, and settle on animated and network-bound pages. Run after npm run build.
// BROWSERMCP_TEST_CHROMIUM: browser binary. BROWSERMCP_TEST_HEADLESS=1: run with --headless=new (no display needed).
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { Tab } from '../dist/src/api/tab.js';
import { Runtime } from '../dist/src/runtime/runtime.js';
import { createExtensionPage } from '../dist/src/backends/extension-page.js';
import { BrowserCommandError } from '../dist/src/host/bridge.js';

const REPORT = process.argv.includes('--report');
const directory = await mkdtemp(join(tmpdir(), 'browsermcp-feedback-'));
const pages = {
  '/opacity': `<title>Checkout</title><button id="pay">Pay</button>
    <div id="ok" style="opacity:0;pointer-events:none"><h2>Payment successful</h2><p>Receipt sent</p></div>
    <div id="shown">Order <b>tot</b>al 42</div>
    <div style="visibility:hidden">Secret <span style="visibility:visible">Shown again</span></div>
    <label><input type="checkbox" id="terms" style="opacity:0">Accept terms</label>`,
  '/effects': `<title>Effects</title><button id="noop">Nothing happens</button>
    <button id="grow" onclick="document.querySelector('#list').append(Object.assign(document.createElement('li'),{textContent:'Added row'}))">Add row</button>
    <input id="name" aria-label="Name"><ul id="list"></ul>
    <a id="nav" href="/opacity">Go to checkout</a>`,
  '/anim': `<title>Animated</title><div id="spin" class="spinner" style="width:20px;height:20px;background:#888"></div>
    <button id="go" onclick="this.textContent='Clicked'">Go</button><button id="idle">Idle</button>
    <script>let n=0;setInterval(()=>{const s=document.querySelector('#spin');s.className='spinner';s.style.transform='rotate('+(n++%360)+'deg)'},16)</script>`,
  '/record': `<title>Jobs</title><style>.tabs span{display:inline-block;margin-right:12px}</style><nav><a href="/record" aria-current="page">Jobs</a><a href="/effects">Effects</a></nav>
    <div class="tabs"><span class="cur">Sales</span><span class="">Support</span><span class="">Design</span></div>
    <ul class="panel cur"><li><p class="name">Sales lead</p><p class="salary"></p><i class="icon" style="display:inline-block;width:12px;height:12px;background:#888"></i><p>Hangzhou</p></li></ul>
    <ul class="panel" style="display:none"><li><p class="name">Support agent</p><p class="salary">10-15K</p></li></ul>
    <ul class="panel" style="display:none"><li><p class="name">Product designer</p><p class="salary">20-30K</p></li></ul>`,
  '/late': `<title>Late</title><div id="app"></div><script>setTimeout(()=>{document.querySelector('#app').innerHTML='<h1>Release notes</h1><p>Version 9.4.1 shipped</p>'},800)</script>`,
  '/spinner': `<title>Spinner</title><div id="app">Loading…</div><script>setTimeout(()=>{document.querySelector('#app').textContent='Order 7731 confirmed'},1500)</script>`,
  '/blank': `<title>Blank</title><div style="width:100px;height:100px;background:#ccc"></div>`,
  '/closed': `<title>Closed</title><div id="host"></div><x-pay></x-pay><p>Outside text</p><div id="open"></div><script>
    const r = document.querySelector('#host').attachShadow({mode:'closed'});
    r.innerHTML = '<label>Card number<input id=c></label><button onclick="this.textContent=\\'Paid\\'">Pay now</button><div id=inner></div>';
    r.querySelector('#inner').attachShadow({mode:'closed'}).innerHTML = '<button>Nested closed</button>';
    customElements.define('x-pay', class extends HTMLElement { constructor() { super(); this.attachShadow({mode:'closed'}).innerHTML = '<a href="#terms">Terms</a>'; } });
    document.querySelector('#open').attachShadow({mode:'open'}).innerHTML = '<button onclick="this.textContent=\\'Opened\\'">Open shadow</button>';
  </script>`,
  '/ambig': `<title>Ambiguous</title><form aria-label="Support"><input aria-label="Work email"></form><div id="widget"></div>
    <table><tbody><tr><td><a href="/news">News</a> | <a href="/new">new</a></td><td>1.</td></tr><tr></tr></tbody></table>
    <script>document.querySelector('#widget').attachShadow({mode:'open'}).innerHTML='<input aria-label="Work email">'</script>`,
  '/details': `<title>Details</title><details><summary>Closed disclosure</summary>Hidden body<p id="hp">Hidden paragraph</p><input aria-label="Hidden field"></details>
    <details open><summary>Open disclosure</summary><p>Open body</p></details>`,
  '/late-button': `<title>Late button</title><p>Ticket 42</p><script>setTimeout(()=>{const b=document.createElement('button');b.textContent='Approve ticket';b.onclick=()=>{b.textContent='Approved'};document.body.append(b)},1500)</script>`,
  '/secrets': `<title>Login</title><form aria-label="Sign in"><input type="password" aria-label="Password" value="hunter2-secret">
    <input aria-label="Card number" autocomplete="cc-number" value="4242424242424242"><input aria-label="City" value="Hangzhou"></form>
    <button id="under">Accept</button><div id="veil" style="position:fixed;inset:0;background:rgba(0,0,0,.3)" aria-label="Cookie banner"></div>`,
  '/cards': `<title>Cards</title><ul>${Array.from({length: 12}, (_, i) => `<li><a href="/effects#job${i + 1}"><h3>Senior Product Designer ${i + 1}</h3><p>Hangzhou</p></a></li>`).join('')}</ul>`,
  '/framed': `<title>Framed</title><p>Outer</p><iframe srcdoc="<button>Inner action</button>"></iframe><div id="sh"></div>
    <script>document.querySelector('#sh').attachShadow({mode:'open'}).innerHTML='<iframe srcdoc="<p>In shadow</p>"></iframe>'</script>`,
  '/to-denied': `<title>Links</title><a href="/denied">Admin area</a>`,
  '/denied': `<title>Forbidden</title><h1>Access denied</h1>`,
  '/login-required': `<title>Sign in</title><h1>Please sign in</h1>`,
  '/xhr': `<title>Async</title><button id="load" onclick="fetch('/slow').then(r=>r.text()).then(t=>{document.querySelector('#out').textContent=t})">Load</button><div id="out"></div>`,
};
const fixture = createServer((req, res) => {
  if (req.url === '/slow') return setTimeout(() => res.end('Loaded data'), 700);
  res.setHeader('content-type', 'text/html');
  if (req.url === '/denied') res.statusCode = 403;
  if (req.url === '/login-required') res.statusCode = 401;
  res.end(pages[req.url] ?? '<title>blank</title>');
});
let context;
const results = {};
const timed = async (tab, opts) => { const t0 = Date.now(); const r = await tab.act(opts); return { ...r, wallMs: Date.now() - t0 }; };
const record = (name, value) => { results[name] = value; if (REPORT) console.log(`${name}: ${JSON.stringify(value)}`); };
try {
  await new Promise(r => fixture.listen(0, r));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Feedback smoke', version: '1.0', permissions: ['debugger', 'tabs', 'webNavigation', 'downloads'], host_permissions: ['<all_urls>'], background: { service_worker: 'worker.js', type: 'module' } }));
  await copyFile('extension/dist/page.js', join(directory, 'page.js'));
  await build({ stdin: { resolveDir: resolve('.'), contents: `
    import * as cdp from './extension/src/cdp.ts';
    import { registerFrameTracking, evaluateInWorld, evaluateMain } from './extension/src/world.ts';
    import { routeFrames } from './extension/src/frames.ts';
    import { frameSteps } from './src/shared/engine.ts';
    import { performAct } from './extension/src/act.ts';
    import { exposeClosedShadowRoots } from './extension/src/shadow.ts';
    cdp.registerListeners(); registerFrameTracking();
    globalThis.runCommand = async ({action, params, tabId}) => {
      if (action === 'act') return {data: await performAct(tabId, params.act, {aggressive:false})};
      if (action !== 'exec') throw new Error('Unexpected command: ' + action);
      const route = await routeFrames(tabId, frameSteps(params.frame), false);
      // As background.ts handleExec does: closed shadow roots are adopted before every engine-world read.
      if (params.world === 'engine') await exposeClosedShadowRoots(tabId, route?.frameId ?? null, false);
      const data = params.world === 'engine'
        ? await evaluateInWorld(tabId, route?.frameId ?? null, params.code, false, params.timeoutMs)
        : await evaluateMain(tabId, route?.frameId ?? null, params.code, false, params.timeoutMs);
      return {data};
    };
  ` }, bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', outfile: join(directory, 'worker.js') });
  const headless = process.env.BROWSERMCP_TEST_HEADLESS === '1';
  context = await chromium.launchPersistentContext(join(directory, 'profile'), {
    ...(process.env.BROWSERMCP_TEST_CHROMIUM && { executablePath: process.env.BROWSERMCP_TEST_CHROMIUM }),
    headless: false, args: [...(headless ? ['--headless=new'] : []), `--disable-extensions-except=${directory}`, `--load-extension=${directory}`], viewport: { width: 1200, height: 900 },
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  for (let i = 0; i < 100 && !await worker.evaluate(() => typeof globalThis.runCommand === 'function'); i++) await new Promise(r => setTimeout(r, 50));
  const rt = new Runtime();
  const open = async (path) => {
    const page = await context.newPage();
    await page.goto(origin + path);
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, page.url());
    const bridge = { extensionFeatures: ['frame-evaluate'], send: async (action, params) => {
      const result = await worker.evaluate(async command => {
        try { return await globalThis.runCommand(command); }
        // As background.ts errorResult: an action error keeps its data (candidates, openedTabs).
        catch (e) { return {error:{message:e.message, code:e.code, hint:e.hint, data:e.extra}}; }
      }, {action, params, tabId});
      if (result.error) throw new BrowserCommandError(result.error.message, result.error.code, result.error.hint, result.error.data);
      return result;
    } };
    const session = `feedback-${tabId}`;
    const transport = await createExtensionPage(bridge, { session, surface: 'browser', page: String(tabId) });
    return { page, tab: new Tab(String(tabId), { rt, sessionId: session, state: rt.session(session) }, transport) };
  };

  // 1. Transparent text is not on screen: it must not be evidence in observe or expect.
  {
    const { page, tab } = await open('/opacity');
    await page.bringToFront();
    const state = (await tab.observe()).state;
    record('opacity.observeShowsHiddenBanner', state.includes('Payment successful'));
    record('opacity.observeShowsVisibleText', state.includes('Order') && state.includes('al 42'));
    record('opacity.observeKeepsTransparentControl', /checkbox "Accept terms"/.test(state));
    record('opacity.observeHidesTransparentChildren', !state.includes('Receipt sent'));
    let wordKept;
    try { wordKept = (await tab.expect({ text: 'Order total 42' }, { timeoutMs: 300 })).ok; } catch { wordKept = false; }
    record('opacity.expectJoinsInlineText', wordKept);
    let override;
    try { override = (await tab.expect({ text: 'Shown again', notText: 'Secret' }, { timeoutMs: 300 })).ok; } catch { override = false; }
    record('opacity.expectHonorsVisibilityOverride', override);
    let passed;
    try { passed = (await tab.expect({ text: 'Payment successful' }, { timeoutMs: 300 })).ok; } catch { passed = false; }
    record('opacity.expectTextPassesOnHiddenBanner', passed);
    let targetVisible;
    try { targetVisible = (await tab.expect({ target: { selector: '#ok' }, visible: true }, { timeoutMs: 300 })).ok; } catch { targetVisible = false; }
    record('opacity.expectVisiblePassesOnHiddenBanner', targetVisible);
    await page.close();
  }

  // 1b. State the ARIA tree lacks: empty fields, class-marked selection, aria-current; hidden panels stay out.
  {
    const { page, tab } = await open('/record');
    await page.bringToFront();
    const first = await tab.observe();
    const state = first.state;
    record('record.emptySlot', /paragraph \[ref=[^\]]+\] \[empty class="salary"\]/.test(state));
    record('record.decorationNotEmpty', !/class="icon"/.test(state));
    record('record.selectedHint', /\[selected\? class="cur"\]: Sales/.test(state) && (state.match(/\[selected\? class="cur"\]/g) ?? []).length === 2);
    record('record.currentLink', /link "Jobs" \[ref=[^\]]+\] \[current=page\]/.test(state));
    record('record.hiddenPanelsOut', !state.includes('Support agent') && !(await tab.read()).text.includes('Support agent'));
    await page.evaluate(() => {
      const spans = document.querySelectorAll('.tabs span'), panels = document.querySelectorAll('ul.panel');
      spans.forEach((s, i) => { s.className = i === 1 ? 'cur' : ''; });
      panels.forEach((p, i) => { p.className = i === 1 ? 'panel cur' : 'panel'; p.style.display = i === 1 ? '' : 'none'; });
    });
    const after = await tab.observe({ since: first.snapshotId });
    // A diff when most of the tree survived, a full state otherwise: either way the new selection and panel are there.
    record('record.switchObserved', /\[selected\? class="cur"\]: Support/.test(after.state) && !/\[selected\? class="cur"\]: Sales/.test(after.state) && after.state.includes('Support agent'));
    if (REPORT) console.log(state + '\n---\n' + after.state);
    await page.close();
  }

  // 1c. A script-rendered page is empty at its load event: wait for content before reading.
  for (const [path, expected, want] of [['/late', 'Version 9.4.1 shipped', 'ready'], ['/spinner', 'Order 7731 confirmed', 'ready'], ['/blank', null, 'empty']]) {
    const { page, tab } = await open(path);
    const before = (await tab.read()).text;
    const t0 = Date.now();
    const state = await tab.use(p => tab.waitForContentOn(p));
    const text = (await tab.read()).text;
    record(`content${path}`, { emptyAtLoad: !expected || !before.includes(expected), state, waitedMs: Date.now() - t0, readsContent: expected ? text.includes(expected) : text === '' });
    await page.close();
  }

  // 1d. Controls inside closed shadow roots (also nested, also in a custom element) are observable and actionable,
  // and a change inside a shadow tree counts as the action's effect.
  {
    const { page, tab } = await open('/closed');
    await page.bringToFront();
    const state = (await tab.observe()).state;
    record('closed.observed', ['textbox "Card number"', 'button "Pay now"', 'button "Nested closed"', 'link "Terms"', 'button "Open shadow"'].filter(t => !state.includes(t)));
    let fill, click, openClick, byRole;
    try { fill = await tab.act({ action: 'fill', target: { label: 'Card number' }, value: '4242' }); } catch (e) { fill = { error: e.code }; }
    try { click = await tab.act({ action: 'click', target: { role: 'button', name: 'Pay now' } }); } catch (e) { click = { error: e.code }; }
    try { openClick = await tab.act({ action: 'click', target: { role: 'button', name: 'Open shadow' } }); } catch (e) { openClick = { error: e.code }; }
    try { byRole = (await tab.expect({ text: 'Paid' }, { timeoutMs: 500 })).ok; } catch { byRole = false; }
    record('closed.acted', { fill: fill.verified ?? fill.error, click: click.effect ?? click.error, openClick: openClick.effect ?? openClick.error, expectText: byRole });
    record('closed.pageSeesNothing', await page.evaluate(() => document.querySelector('#host').shadowRoot === null && document.querySelector('x-pay').shadowRoot === null));
    if (REPORT) console.log(state);
    await page.close();
  }

  // 1e. Ambiguity names its candidates; a locator that matches nothing on a quiet page fails fast; layout tables are compact.
  {
    const { page, tab } = await open('/ambig');
    await page.bringToFront();
    const state = (await tab.observe()).state;
    let amb; try { await tab.act({ action: 'fill', target: { role: 'textbox', name: 'Work email' }, value: 'x' }); amb = { code: 'none' }; } catch (e) { amb = { code: e.code, message: e.message, candidates: e.data?.candidates ?? e.toJSON?.().candidates }; }
    await new Promise(r => setTimeout(r, 2000)); // the agent has been reading this page for a while
    const t0 = Date.now();
    let missing; try { await tab.act({ action: 'click', target: { role: 'button', name: 'Does not exist' } }); missing = 'none'; } catch (e) { missing = e.code; }
    record('actAmbiguityCandidates', (amb.candidates ?? []).map(c => c.within));
    record('ambig', { code: amb.code, namesBoth: /form "Support"/.test(amb.message ?? '') && /shadow root of <div#widget>/.test(amb.message ?? ''), refs: (amb.message?.match(/\[ref=/g) ?? []).length });
    record('notFound', { code: missing, ms: Date.now() - t0 });
    let expAmb; try { await tab.expect({ target: { role: 'textbox', name: 'Work email' }, visible: true }, { timeoutMs: 300 }); expAmb = null; } catch (e) { expAmb = e.toJSON?.() ?? e; }
    record('expectAmbiguityCandidates', (expAmb?.candidates ?? []).map(c => c.within));
    record('layoutTable', { wrappers: /rowgroup|- cell \[|- row \[ref=[^\]]+\]$|text: "?\|/m.test(state), links: /link "News"/.test(state) && /link "new"/.test(state), namedCell: /cell "1\."/.test(state) });
    if (REPORT) console.log(state);
    await page.close();
  }

  // 1h. Credential values never reach the agent (snapshot, DOM evidence, expect actual); a covering layer is named.
  {
    const { page, tab } = await open('/secrets');
    await page.bringToFront();
    const state = (await tab.observe()).state;
    const dom = JSON.stringify((await tab.observe({ format: 'dom' })).dom);
    let actual; try { await tab.expect({ target: { label: 'Password' }, value: 'wrong' }, { timeoutMs: 200 }); } catch (e) { actual = JSON.stringify(e.toJSON?.().actual ?? e.data?.actual ?? ''); }
    record('secrets', { snapshot: !/hunter2|4242424242424242/.test(state) && state.includes('Hangzhou'), dom: !/hunter2|4242424242424242/.test(dom) && dom.includes('Hangzhou'), expectActual: !/hunter2/.test(actual ?? '') });
    let blocked; try { await tab.act({ action: 'click', target: { role: 'button', name: 'Accept' }, timeoutMs: 800 }); blocked = { code: 'clicked' }; } catch (e) { blocked = { code: e.code, message: e.message }; }
    record('covered', { code: blocked.code, namesCover: /veil|Cookie banner/.test(blocked.message ?? '') });
    await page.close();
  }

  // 1i. Names match by substring; the one whose whole name is the requested name wins, otherwise the error says why.
  {
    const results1i = {};
    for (const name of ['Senior Product Designer 1', 'senior  product designer 1', 'Senior Product Designer']) {
      const { page, tab } = await open('/cards');
      try { const r = await tab.act({ action: 'click', target: { role: 'link', name } }); results1i[name] = r.url ?? r.effect; }
      catch (e) { results1i[name] = `${e.code}${/substring/.test(e.hint ?? '') ? ' (substring hint)' : ''}`; }
      await page.close();
    }
    record('exactName', results1i);
  }

  // A single semantic target identifies the same card for evidence, expectations, and either click method.
  {
    const { page, tab } = await open('/cards');
    const target = { role: 'link', name: 'Senior Product Designer 1' };
    const detail = await tab.read({ target });
    assert.match(detail.text, /Designer 1/);
    assert.doesNotMatch(detail.text, /Designer 10/);
    const observation = await tab.observe({ target, viewport: false });
    assert.match(observation.state, /Designer 1/);
    assert.doesNotMatch(observation.state, /Designer 10/);
    await tab.expect({ target, visible: true });
    const clicked = await tab.act({ action: 'click', target, method: 'dom' });
    assert.equal(clicked.url, `${origin}/effects#job1`);
    await page.close();
  }

  // 1j. A locator that misses in the top document says that child frames are not searched and how to reach them.
  {
    const { page, tab } = await open('/framed');
    const st = await tab.observe();
    let miss; try { await tab.act({ action: 'click', target: { role: 'button', name: 'Inner action' } }); miss = 'clicked'; } catch (e) { miss = `${e.code}${/contains 2 frames/.test(e.hint ?? '') ? ' (frame hint)' : ''}`; }
    const framePath = st.frames?.[0]?.frame;
    let hit; try { hit = (await tab.act({ action: 'click', target: { role: 'button', name: 'Inner action', frame: framePath } })).effect; } catch (e) { hit = e.code; }
    record('frameHint', { miss, withFrame: hit === 'changed' || hit === 'none' });
    await page.close();
  }

  // 1g. A target that renders a moment after load is still waited for (fast failure is only for long-quiet pages).
  for (const [label, opts] of [['default', {}], ['explicitTimeout', { timeoutMs: 6000 }]]) {
    const { page, tab } = await open('/late-button');
    const t0 = Date.now();
    let r; try { r = await tab.act({ action: 'click', target: { role: 'button', name: 'Approve ticket' }, ...opts }); } catch (e) { r = { error: e.code }; }
    record(`lateTarget.${label}`, { effect: r.effect ?? r.error, ms: Date.now() - t0 });
    await page.close();
  }

  // 1f. Content of a closed <details> is not on screen: not observed, not read, not evidence; summaries carry their state.
  {
    const { page, tab } = await open('/details');
    await page.bringToFront();
    const state = (await tab.observe()).state;
    const read = (await tab.read()).text;
    let textOk, visibleOk;
    try { textOk = (await tab.expect({ text: 'Hidden body' }, { timeoutMs: 300 })).ok; } catch { textOk = false; }
    try { visibleOk = (await tab.expect({ target: { selector: '#hp' }, visible: true }, { timeoutMs: 300 })).ok; } catch { visibleOk = false; }
    let textVisible; try { textVisible = (await tab.expect({ target: { text: 'Hidden body' }, visible: true }, { timeoutMs: 300 })).ok; } catch { textVisible = false; }
    record('details.textLocatorVisible', textVisible);
    record('details', {
      observeHides: !/Hidden (body|paragraph|field)/.test(state), observeShowsOpen: state.includes('Open body'),
      readHides: !read.includes('Hidden'), expectText: textOk, expectVisible: visibleOk,
      states: [/Closed disclosure"?[^\n]*\[collapsed\]|\[collapsed\][^\n]*Closed disclosure/.test(state), /Open disclosure"?[^\n]*\[expanded\]|\[expanded\][^\n]*Open disclosure/.test(state)],
    });
    if (REPORT) console.log(state);
    await page.close();
  }

  // 2. The agent learns from the action itself whether the page reacted.
  {
    const { page, tab } = await open('/effects');
    await page.bringToFront();
    await tab.observe();
    const noop = await timed(tab, { action: 'click', target: { selector: '#noop' } });
    const grow = await timed(tab, { action: 'click', target: { selector: '#grow' } });
    const fill = await tab.act({ action: 'fill', target: { selector: '#name' }, value: 'Ada' });
    const nav = await tab.act({ action: 'click', target: { selector: '#nav' } });
    record('effect.noop', { effect: noop.effect, wallMs: noop.wallMs });
    record('effect.grow', { effect: grow.effect, wallMs: grow.wallMs });
    record('effect.fill', { effect: fill.effect });
    record('effect.nav', { effect: nav.effect, navigated: nav.navigated });
    await page.close();
  }

  // 3. Settle: an animation loop is not the page reacting; an in-flight request is.
  {
    const { page, tab } = await open('/anim');
    await page.bringToFront();
    await new Promise(r => setTimeout(r, 300));
    const idle = await timed(tab, { action: 'click', target: { selector: '#idle' } });
    const anim = await timed(tab, { action: 'click', target: { selector: '#go' } });
    record('settle.animatedNoop', { wallMs: idle.wallMs, effect: idle.effect });
    record('settle.animated', { wallMs: anim.wallMs, effect: anim.effect });
    await page.close();
  }
  {
    const { page, tab } = await open('/xhr');
    await page.bringToFront();
    const load = await timed(tab, { action: 'click', target: { selector: '#load' } });
    const text = await page.evaluate(() => document.querySelector('#out').textContent);
    record('settle.xhr', { wallMs: load.wallMs, resultPresentWhenActReturned: text === 'Loaded data', effect: load.effect });
    await page.close();
  }

  // HTTP failures of the page's own document are reported with the call; the agent can flag a tab for the user.
  {
    const { page, tab } = await open('/to-denied');
    const events = []; const onEvent = (e) => events.push(e); rt.on('browser-event', onEvent);
    const clicked = await tab.act({ action: 'click', target: { role: 'link', name: 'Admin area' } });
    await page.goto(origin + '/login-required');
    await tab.use((p) => tab.checkDocumentOn(p));
    await page.goto(origin + '/effects');
    await tab.use((p) => tab.checkDocumentOn(p));
    const reported = await tab.reportIssue('auth_required', { note: 'Sign-in form shown' });
    rt.off('browser-event', onEvent);
    const changes = await rt.changesSince(`feedback-${tab.id}`, 0);
    record('issues', {
      clickNavigated: clicked.effect,
      codes: (changes?.issues ?? []).map((i) => `${i.code}:${i.source}:${i.status ?? ''}`),
      reported: reported.reported,
      attention: events.filter((e) => e.kind === 'attention').map((e) => `${e.reason}:${e.waiting}:${e.url?.endsWith('/effects')}`),
    });
    await page.close();
  }

  if (!REPORT) {
    assert.equal(results['opacity.observeShowsVisibleText'], true, 'visible text must be observed');
    assert.equal(results['opacity.observeShowsHiddenBanner'], false, 'opacity:0 text must not be observed as page content');
    assert.equal(results['opacity.expectTextPassesOnHiddenBanner'], false, 'expect({text}) must not pass on opacity:0 text');
    assert.equal(results['opacity.expectVisiblePassesOnHiddenBanner'], false, 'expect({visible}) must not pass on an opacity:0 element');
    assert.equal(results['opacity.observeKeepsTransparentControl'], true, 'a transparent native control is still clickable and must stay observable');
    assert.equal(results['opacity.observeHidesTransparentChildren'], true, 'descendants of a transparent element are not on screen');
    assert.equal(results['opacity.expectJoinsInlineText'], true, 'inline elements must not split words');
    assert.equal(results['opacity.expectHonorsVisibilityOverride'], true, 'visibility:visible inside visibility:hidden is on screen');
    console.log('Passed: transparent text is neither observed nor accepted as evidence.');
    for (const key of ['record.emptySlot', 'record.decorationNotEmpty', 'record.selectedHint', 'record.currentLink', 'record.hiddenPanelsOut', 'record.switchObserved']) assert.equal(results[key], true, key);
    for (const path of ['/late', '/spinner', '/blank']) {
      const r = results[`content${path}`];
      assert.equal(r.emptyAtLoad, true, `${path} must start empty, or the case tests nothing`);
      assert.equal(r.readsContent, true, `${path}: ${JSON.stringify(r)}`);
    }
    assert.equal(results['content/late'].state, 'ready'); assert.equal(results['content/spinner'].state, 'ready'); assert.equal(results['content/blank'].state, 'empty');
    assert(results['content/blank'].waitedMs < 3000, 'a page without text is released after about 2 s');
    console.log('Passed: after a load the wait returns once script-rendered content and placeholders have resolved.');
    assert.deepEqual(results['closed.observed'], [], 'controls inside closed shadow roots must be observed');
    assert.deepEqual(results['closed.acted'], { fill: true, click: 'changed', openClick: 'changed', expectText: true });
    assert.equal(results['closed.pageSeesNothing'], true, 'page scripts must still see closed roots as closed');
    assert.deepEqual(results.secrets, { snapshot: true, dom: true, expectActual: true }, 'credential values must never reach the agent');
    assert.deepEqual(results.covered, { code: 'intercepted', namesCover: true }, JSON.stringify(results.covered));
    assert.deepEqual(results.exactName, { 'Senior Product Designer 1': `${origin}/effects#job1`, 'senior  product designer 1': `${origin}/effects#job1`, 'Senior Product Designer': 'selector_ambiguous (substring hint)' });
    assert.deepEqual(results.frameHint, { miss: 'not_found (frame hint)', withFrame: true });
    assert.deepEqual(results.ambig, { code: 'selector_ambiguous', namesBoth: true, refs: 2 });
    assert.equal(results.notFound.code, 'not_found'); assert(results.notFound.ms < 1200, `not_found took ${results.notFound.ms} ms`);
    assert.deepEqual(results.actAmbiguityCandidates, ['form "Support"', 'shadow root of <div#widget>']);
    assert.deepEqual(results.expectAmbiguityCandidates, ['form "Support"', 'shadow root of <div#widget>']);
    assert.equal(results['lateTarget.default'].effect, 'changed', JSON.stringify(results['lateTarget.default']));
    assert.equal(results['lateTarget.explicitTimeout'].effect, 'changed', JSON.stringify(results['lateTarget.explicitTimeout']));
    assert.deepEqual(results.layoutTable, { wrappers: false, links: true, namedCell: true });
    console.log('Passed: ambiguity lists candidates with their region; a missing target on a quiet page fails fast; layout tables are compact.');
    assert.equal(results['details.textLocatorVisible'], false, 'text inside a closed <details> is not visible through a text locator');
    assert.deepEqual(results.details, { observeHides: true, observeShowsOpen: true, readHides: true, expectText: false, expectVisible: false, states: [true, true] });
    console.log('Passed: closed <details> content is neither observed, read nor accepted as evidence; disclosures show their state.');
    console.log('Passed: closed shadow roots are observed, actionable and watched for effects.');
    console.log('Passed: empty fields, class-marked selection and aria-current are in the snapshot; hidden panels are not.');
    assert.equal(results['effect.noop'].effect, 'none');
    assert.equal(results['effect.grow'].effect, 'changed');
    assert.equal(results['effect.fill'].effect, 'changed');
    assert.equal(results['effect.nav'].effect, 'navigated');
    console.log('Passed: every action reports whether the page navigated, changed, or did not react.');
    assert(results['settle.animated'].wallMs < results['effect.grow'].wallMs + 250, `animation must not hold settle open: ${results['settle.animated'].wallMs}ms vs ${results['effect.grow'].wallMs}ms on a static page`);
    assert.equal(results['settle.animated'].effect, 'changed', 'the button text change is still detected under animation');
    assert.equal(results['settle.animatedNoop'].effect, 'none', 'an animation loop is not the page reacting');
    assert.equal(results['settle.xhr'].resultPresentWhenActReturned, true, 'settle must wait for the request the click started');
    console.log('Passed: settle ignores animation noise and waits for fresh requests.');
    assert.deepEqual(results.issues, { clickNavigated: 'navigated', codes: ['blocked:detected:403', 'auth_required:detected:401', 'auth_required:agent:'], reported: 'auth_required', attention: ['auth_required:true:true'] }, JSON.stringify(results.issues));
    console.log('Passed: 401/403 documents become issues; an agent-flagged tab is announced to the embedding browser.');
  }
} finally {
  await context?.close();
  await new Promise(r => fixture.close(r));
  await rm(directory, { recursive: true, force: true });
}
