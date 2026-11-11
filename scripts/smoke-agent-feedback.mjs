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
  '/xhr': `<title>Async</title><button id="load" onclick="fetch('/slow').then(r=>r.text()).then(t=>{document.querySelector('#out').textContent=t})">Load</button><div id="out"></div>`,
};
const fixture = createServer((req, res) => {
  if (req.url === '/slow') return setTimeout(() => res.end('Loaded data'), 700);
  res.setHeader('content-type', 'text/html');
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
    cdp.registerListeners(); registerFrameTracking();
    globalThis.runCommand = async ({action, params, tabId}) => {
      if (action === 'act') return {data: await performAct(tabId, params.act, {aggressive:false})};
      if (action !== 'exec') throw new Error('Unexpected command: ' + action);
      const route = await routeFrames(tabId, frameSteps(params.frame), false);
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
        catch (e) { return {error:{message:e.message, code:e.code, hint:e.hint}}; }
      }, {action, params, tabId});
      if (result.error) throw Object.assign(new Error(result.error.message), result.error);
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
  }
} finally {
  await context?.close();
  await new Promise(r => fixture.close(r));
  await rm(directory, { recursive: true, force: true });
}
