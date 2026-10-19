import { app, BrowserWindow, session as electronSession } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
const { createEmbeddedBrowser } = await import(process.env.BROWSERMCP_SMOKE_SDK ?? '../dist/src/embedded/index.js');

const root = process.env.BROWSERMCP_SMOKE_ROOT;
app.on('window-all-closed', () => {});
const windows = new Set();
const clients = [];
let service, server;
const deadline = setTimeout(() => { console.error('Embedded smoke timed out'); app.exit(1); }, 60000);
try {
  await app.whenReady();
  server = http.createServer((req, res) => { if (req.url === '/api') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({verified:true})); return; } if (req.url === '/frame') { res.setHeader('Content-Type', 'text/html'); res.end('<label>Child<input aria-label="Child"></label>'); return; } res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Embedded fixture</title><label>Name<input aria-label="Name"></label><button onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'input\').value">Save</button><p id="result">Empty</p><iframe src="/frame"></iframe>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = scope => electronSession.fromPartition(`persist:${scope.profileId}`);
  const createPage = async scope => {
    const window = new BrowserWindow({ show: false, webPreferences: { session: profile(scope), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    windows.add(window); window.once('closed', () => windows.delete(window));
    return window.webContents;
  };
  service = await createEmbeddedBrowser({ dataDir: path.join(root, 'data'), execution: 'trusted-node', browser: { createPage, profile, closePage: async contents => BrowserWindow.fromWebContents(contents).destroy() } });
  const connect = async profileId => {
    const handle = service.createSession({ workspaceId: 'workspace', profileId });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: profileId, version: '1' });
    await handle.server.connect(serverTransport); await client.connect(clientTransport); clients.push(client);
    const js = async code => {
      const result = await client.callTool({ name: 'js', arguments: { code } });
      const body = JSON.parse(result.content[0].text);
      assert.equal(result.isError ?? false, false, JSON.stringify(body));
      return body.value;
    };
    return { handle, client, js };
  };
  const a = await connect('alpha'), b = await connect('beta');
  console.log('smoke: connected');
  await a.js('let events = await browser.chrome.watch("tabs.onCreated")');
  await a.js(`let tab = await browser.tabs.new(${JSON.stringify(url)}); tab.id`);
  const observation = await a.js('await tab.observe()');
  assert.match(observation.state, /Name/);
  await a.js('await tab.act({action:"fill",target:{label:"Name"},value:"Electron works"})');
  await a.js('await tab.act({action:"click",target:{role:"button",name:"Save"}})');
  await a.js('await tab.expect({text:"Electron works"})');
  await a.js('await tab.act({action:"fill",target:{label:"Child",frame:0},value:"inside frame"})');
  assert.equal(await a.js(`await tab.evaluate(${JSON.stringify("document.querySelector('input').value")}, {frame:0})`), 'inside frame');
  assert.equal((await a.js('await events.read()')).entries.length, 1);
  assert.equal((await b.js('await browser.chrome.call("tabs.query", [{}])')).length, 0);
  await a.js(`await tab.evaluate("fetch('/api').then(r=>r.json())")`);
  const network = await a.js('await tab.network.read({limit:100})');
  assert.ok(network.entries.some(entry => entry.url.endsWith('/api') && entry.responsePreview?.includes('verified')));
  const image = await a.js('let shot = await tab.screenshot(); ({mimeType:shot.mimeType,length:shot.base64.length})');
  assert.ok(image.length > 100);
  const cookieArgs = JSON.stringify({ url, name: 'account', value: 'alpha' });
  await a.js(`await browser.chrome.call('cookies.set', [${cookieArgs}])`);
  assert.equal((await b.js(`await browser.chrome.call('cookies.getAll', [{url:${JSON.stringify(url)}}])`)).length, 0);
  await b.js(`let tab = await browser.tabs.new(${JSON.stringify(url)}); await browser.chrome.call('cookies.set',[{url:${JSON.stringify(url)},name:'account',value:'beta'}])`);
  const definition = { site: 'fixture', name: 'account', description: 'Read current profile account', access: 'read', func: 'async ({tab}) => ({account: await tab.evaluate("document.cookie")})' };
  const draft = await a.js(`await tools.define(${JSON.stringify(definition)})`);
  await a.js(`await tools.try(${JSON.stringify(draft.draftId)}, {}, {path:'value.account',equals:'account=alpha'})`);
  await a.js(`await tools.activate(${JSON.stringify(draft.draftId)})`);
  assert.equal((await a.js('await sites.run("fixture","account",{})')).account, 'account=alpha');
  assert.equal((await b.js('await sites.run("fixture","account",{})')).account, 'account=beta');
  const changed = await a.js(`await tools.define(${JSON.stringify({ ...definition, func: 'async ({tab}) => ({account: await tab.evaluate("document.cookie"), revision: 2})' })})`);
  await a.js(`await tools.try(${JSON.stringify(changed.draftId)}, {}, {path:'value.revision',equals:2}); await tools.activate(${JSON.stringify(changed.draftId)})`);
  assert.equal((await b.js('await sites.run("fixture","account",{})')).revision, 2);
  console.log('smoke: adapters and profiles verified');
  const userContents = await createPage({ workspaceId: 'workspace', profileId: 'alpha' });
  await userContents.loadURL(url);
  service.registerPage(userContents, { workspaceId: 'workspace', profileId: 'alpha' });
  await a.js(`let borrowed = await browser.user.claimTab({tabId:${userContents.id}})`);
  await a.client.callTool({ name: 'session_finalize', arguments: {} });
  assert.equal(userContents.isDestroyed(), false);
  const doomed = await a.js(`let doomed = await browser.tabs.new(${JSON.stringify(url)}); (await browser.tabs.list()).find(item => item.id === doomed.id).tabId`);
  const target = [...windows].find(window => doomed === window.webContents.id);
  // Destroy the remaining agent-created page from the host, then verify stale handles fail.
  const doomedId = await a.js('doomed.id');
  service.unregisterPage(doomedId);
  const stale = await a.client.callTool({ name:'js', arguments:{ code:'await doomed.observe()' } });
  assert.equal(stale.isError, true);
  target?.destroy();
  const timeout = await a.client.callTool({ name:'js', arguments:{ code:'await new Promise(() => {})', timeoutMs: 30 } });
  assert.equal(timeout.isError, true);
  assert.equal((await b.js('await sites.run("fixture","account",{})')).account, 'account=beta');
  console.log('smoke: finalizing sessions');
  await a.handle.close(); await b.handle.close();
  console.log('smoke: sessions closed');
  assert.equal(windows.size, 1);
  console.log('PASS embedded MCP: observe/act/verify, frames, network bodies, screenshots, Chrome calls/events, profiles, adapter creation/update, revocation, timeout, user-tab preservation and cleanup');
} catch (error) {
  console.error(error.stack ?? error); process.exitCode = 1;
} finally {
  console.log('smoke: disposing service');
  for (const client of clients) await client.close().catch(() => {});
  await service?.dispose().catch(error => { console.error(error); process.exitCode = 1; });
  for (const window of windows) window.destroy();
  server?.closeAllConnections();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  // Chromium can still have profile writes in flight until app.exit. The parent runner removes root.
  clearTimeout(deadline);
  app.exit(process.exitCode ?? 0);
}
