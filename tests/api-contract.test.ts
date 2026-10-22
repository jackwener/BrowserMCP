import { afterEach, describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { Tab } from '../src/api/tab.js';
import { Browser } from '../src/api/browser.js';
import { JsSession } from '../src/mcp/js-session.js';
import { createExtensionPage } from '../src/backends/extension-page.js';
import type { PageTransport } from '../src/backends/page-transport.js';
import type { SessionContext } from '../src/api/context.js';
import { discoverTabs, discoveryResult, type TabInventoryEntry } from '../src/shared/api-contract.js';

const sessions: JsSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(s => s.dispose())); });
function fixture() {
  let dispatches = 0;
  const context = vm.createContext({ effects: 0 });
  const tab = new Tab('test', {} as SessionContext);
  Object.assign(tab, { use: async (fn: (page: unknown) => unknown) => fn({ evaluate: async (code: string) => { dispatches++; return vm.runInContext(code, context); } }) });
  const session = new JsSession({ tab }); sessions.push(session);
  return { tab, session, context, dispatches: () => dispatches };
}
const entry = (tabId: number, extra = {}): TabInventoryEntry => ({ tab: { tabId, url: 'https://x.com/home', title: 'Home / X', windowId: 1, active: false, lastAccessed: tabId }, supported: true, owned: false, ...extra });

describe('executable API contracts through the REPL', () => {
  it('rejects malformed evaluate calls before page effects and recovers in the same session', async () => {
    const f = fixture();
    for (const args of ['5', 'null', '[5]', '{args:5}', '{arg:NaN}', '{arg:Infinity}', '{arg:-0}', '{arg:1n}', '{arg:new Date()}', '{arg:new Map()}', '{arg:new Set()}', '{arg:/x/}', '{arg:new Uint8Array([1])}', '{arg:{x:undefined}}', '{arg:[,1]}', '{arg:()=>1}', '{arg: { get x() {throw new Error("must not read accessor")} }}', '{timeoutMs:0}', '{frame:[]}']) {
      const result = await f.session.run(`await tab.evaluate(n => { globalThis.effects++; return n; }, ${args})`);
      expect(result.error, args).toMatchObject({ code: 'invalid_args', data: { dispatched: false } });
    }
    const cyclic = await f.session.run('let cycle={}; cycle.self=cycle; await tab.evaluate(x=>x,{arg:cycle})');
    expect(cyclic.error?.code).toBe('invalid_args');
    expect((await f.session.run('await tab.evaluate(x=>x, {}, 5)')).error?.code).toBe('invalid_args');
    expect((await f.session.run('await tab.evaluate("1", {arg:5})')).error?.code).toBe('invalid_args');
    expect((await f.session.run('await tab.evaluate({$function:"()=>1"})')).error?.code).toBe('invalid_args');
    expect(f.dispatches()).toBe(0);
    expect(f.context.effects).toBe(0);
    const good = await f.session.run('await tab.evaluate(n => { globalThis.effects++; return Array.from({length:n}, (_,i)=>i); }, {arg:5})');
    expect(good.error).toBeUndefined(); expect(good.value).toEqual([0,1,2,3,4]);
    expect(f.dispatches()).toBe(1); expect(f.context.effects).toBe(1);
  });

  it('preserves data marker keys and shared subobjects without confusing them with handles', async () => {
    const f = fixture();
    const result = await f.session.run('let shared={x:1}; await tab.evaluate(x=>x, {arg: {$remote:1, $function:"data", a:shared, b:shared}})');
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ $remote: 1, $function: 'data', a: {x:1}, b: {x:1} });
    const prototypeKey = await f.session.run(`await tab.evaluate(x => ({own:Object.hasOwn(x,"__proto__"),value:x.__proto__}), {arg:JSON.parse('{"__proto__":{"x":1}}')})`);
    expect(prototypeKey.value).toEqual({own:true,value:{x:1}});
    // Direct adapter calls obey the same contract, independently of worker validation.
    await expect(f.tab.evaluate(x => x, {arg: new Date()})).rejects.toMatchObject({code:'invalid_args'});
  });
});

describe('tab discovery contract', () => {
  it('explains scope, substring matches, pagination and zero results from one inventory', () => {
    const inventory = [entry(1), entry(2), entry(3, {owned:true}), entry(4, {supported:false})];
    const first = discoverTabs(inventory, {query:'  X.COM/HOME  ', limit:1});
    expect(first).toMatchObject({ totalVisible:4,totalInScope:2,excluded:{owned:1,unsupported:1},matched:2,hasMore:true,nextOffset:1,items:[{tabId:2}] });
    expect(discoveryResult.safeParse(first).success).toBe(true);
    expect(discoverTabs(inventory, {query:'x.com/home', offset:first.nextOffset,limit:1})).toMatchObject({matched:2,hasMore:false,items:[{tabId:1}]});
    expect(discoverTabs(inventory, {query:'home x'})).toMatchObject({matched:0,totalInScope:2,items:[]});
    expect(discoverTabs([])).toMatchObject({matched:0,totalInScope:0,items:[]});
    expect(discoverTabs(inventory, {query:'Home / X'}).matched).toBe(2);
    expect(() => discoverTabs(inventory, {limit:0})).toThrow();
    expect(() => discoverTabs(inventory, {offset:-1})).toThrow();
  });

  it('validates before backend calls, rejects invalid responses and recovers through public Browser + REPL', async () => {
    let calls = 0, bad = false;
    const page = await createExtensionPage({send: async () => {calls++; return {data: bad ? [] : discoverTabs([entry(3)])};}} as unknown as PageTransport, {session:'test',surface:'browser'});
    const ctx = {sessionId:'test',rt:{getBrowserPage:async()=>page,isManagedPage:()=>true}} as unknown as SessionContext;
    const session = new JsSession({browser:new Browser('test','extension',ctx)}); sessions.push(session);
    for (const code of ['await browser.user.openTabs(5)', 'await browser.user.openTabs({query:5})','await browser.user.openTabs({queryy:"x"})', 'await browser.user.openTabs({}, 1)']) expect((await session.run(code)).error?.code).toBe('invalid_args');
    expect(calls).toBe(0);
    bad = true;
    expect((await session.run('await browser.user.openTabs()')).error?.code).toBe('invalid_response');
    bad = false;
    expect((await session.run('await browser.user.openTabs()')).value).toMatchObject({matched:1,items:[{tabId:3}]});
  });
});
