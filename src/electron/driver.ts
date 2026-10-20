import type { WebContents } from 'electron';
import { readFileSync } from 'node:fs';
import { INJECTED_SOURCE } from '../shared/injected-source.js';
import { installEngineJs, pageCallJs, unwrapPageResult, PAGE_GLOBAL, frameSteps, performAct } from '../shared/engine.js';
import type { ActSpec, FrameStep, DialogInfo } from '../protocol.js';
import { ActionError } from '../api/errors.js';

type Evaluation = { result: { value?: unknown; objectId?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } };

/** CDP stays on the application's registered target; no remote-debugging port is opened. */
export class ElectronDriver {
  private attached = false;
  private contexts = new Map<string, number>();
  private targets = new Map<string, string>();
  private disposed = false;
  private readonly mainContexts = new Map<string, number>();
  private readonly network = new Map<string, Record<string, unknown>>();
  private readonly bodies = new Set<Promise<void>>();
  private capturePattern = '';
  private initialization?: Promise<void>;
  dialogInfo: DialogInfo | null = null;
  private readonly onMessage = (_event: unknown, method: string, params: any, sessionId?: string) => {
    if (method === 'Runtime.executionContextsCleared') { this.contexts.clear(); this.mainContexts.clear(); }
    if (method === 'Page.frameNavigated') this.contexts.clear();
    if (method === 'Runtime.executionContextCreated' && params.context.auxData?.isDefault) this.mainContexts.set(params.context.auxData.frameId, params.context.id);
    if (method === 'Target.attachedToTarget') {
      this.targets.set(params.targetInfo.targetId, params.sessionId);
      void this.send('Runtime.enable', {}, params.sessionId).catch(() => {});
      void this.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
    }
    if (method === 'Target.detachedFromTarget') { for (const [id, session] of this.targets) if (session === params.sessionId) this.targets.delete(id); this.contexts.clear(); }
    if (method === 'Network.requestWillBeSent') {
      const request = params.request;
      if (!this.capturePattern || request.url.includes(this.capturePattern)) {
        this.network.set(params.requestId, { requestId: params.requestId, url: request.url, method: request.method, type: params.type, timestamp: params.timestamp, requestBodyPreview: request.postData?.slice(0, 16000), requestBodyFullSize: request.postData?.length, requestBodyTruncated: Boolean(request.postData && request.postData.length > 16000) });
        while (this.network.size > 500) this.network.delete(this.network.keys().next().value!);
      }
    }
    if (method === 'Network.responseReceived') {
      const entry = this.network.get(params.requestId);
      if (entry) Object.assign(entry, { status: params.response.status, mimeType: params.response.mimeType });
    }
    if (method === 'Network.loadingFailed') {
      const entry = this.network.get(params.requestId);
      if (entry) Object.assign(entry, { finished: true, error: params.errorText });
    }
    if (method === 'Network.loadingFinished') {
      const entry = this.network.get(params.requestId);
      if (entry) {
        const body = (async () => {
          try {
            if (/json|text|javascript|xml/.test(String(entry.mimeType ?? ''))) {
              const result = await this.send('Network.getResponseBody', { requestId: params.requestId }, sessionId);
              const value = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : String(result.body);
              Object.assign(entry, { responsePreview: value.slice(0, 64000), responseBodyFullSize: value.length, responseBodyTruncated: value.length > 64000 });
            }
          } catch (error) { entry.responseBodyError = String(error); }
          finally { entry.finished = true; }
        })();
        this.bodies.add(body); void body.finally(() => this.bodies.delete(body));
      }
    }
    if (method === 'Page.javascriptDialogOpening') this.dialogInfo = { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt, url: params.url, openedAt: Date.now() };
    if (method === 'Page.javascriptDialogClosed') this.dialogInfo = null;
  };
  private readonly onDetach = () => { this.contents.debugger.removeListener('message', this.onMessage); this.contents.debugger.removeListener('detach', this.onDetach); this.attached = false; this.initialization = undefined; this.contexts.clear(); this.targets.clear(); };

  constructor(readonly contents: WebContents, private readonly pageModule: string = readFileSync(new URL('./page.js', import.meta.url), 'utf8')) {}

  async ready(): Promise<void> {
    if (this.disposed || this.contents.isDestroyed()) throw new ActionError('stale_page', 'Page is no longer available');
    if (!this.initialization) this.initialization = this.initialize().catch(error => { this.initialization = undefined; throw error; });
    return this.initialization;
  }
  private async initialize(): Promise<void> {
    const debuggerApi = this.contents.debugger;
    if (debuggerApi.isAttached()) throw new ActionError('debugger_in_use', 'The page debugger is already owned by another client');
    debuggerApi.attach('1.3');
    this.attached = true;
    debuggerApi.on('message', this.onMessage);
    debuggerApi.on('detach', this.onDetach);
    try {
      await this.send('Page.enable');
      await this.send('Runtime.enable');
      await this.send('Network.enable');
      await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    } catch (error) { this.dispose(); throw error; }
  }
  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15000): Promise<any> {
    if (this.disposed || this.contents.isDestroyed() || !this.attached) throw new ActionError('stale_page', 'Debugger target is unavailable');
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      this.contents.debugger.sendCommand(method, params, sessionId || undefined),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ActionError('command_outcome_unknown', `${method} timed out; it may have executed`)), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
  }
  private sessionFor(frameId: string): string | undefined { return this.targets.get(frameId); }
  async evaluate(expression: string, contextId?: number, frameId?: string, timeoutMs = 15000, byValue = true): Promise<unknown> {
    await this.ready();
    const result: Evaluation = await this.send('Runtime.evaluate', { expression, ...(contextId !== undefined && { contextId }), awaitPromise: true, returnByValue: byValue, userGesture: true }, frameId ? this.sessionFor(frameId) : undefined, timeoutMs);
    if (result.exceptionDetails) throw new ActionError('page_error', result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Page evaluation failed');
    return byValue ? result.result.value : result.result.objectId;
  }
  async rootFrame(): Promise<string> { await this.ready(); return (await this.send('Page.getFrameTree')).frameTree.frame.id; }
  async engineContext(frameId: string): Promise<number> {
    const existing = this.contexts.get(frameId);
    if (existing !== undefined) return existing;
    const { executionContextId } = await this.send('Page.createIsolatedWorld', { frameId, worldName: 'browsermcp-engine' }, this.sessionFor(frameId));
    await this.evaluate(installEngineJs(INJECTED_SOURCE, this.pageModule), executionContextId, frameId);
    this.contexts.set(frameId, executionContextId);
    return executionContextId;
  }
  async callIn(frameId: string, fn: string, args?: unknown, timeoutMs?: number): Promise<unknown> {
    return unwrapPageResult(await this.evaluate(pageCallJs(fn, args), await this.engineContext(frameId), frameId, timeoutMs));
  }
  async route(frame?: FrameStep | FrameStep[], scroll = false): Promise<{ frameId: string; offset: { x: number; y: number } }> {
    let frameId = await this.rootFrame();
    const offset = { x: 0, y: 0 };
    for (const step of frameSteps(frame)) {
      const probe = await this.callIn(frameId, 'frameProbe', { step, scroll }) as { found: boolean; x: number; y: number };
      if (!probe.found) throw new ActionError('frame_not_found', `No iframe matches ${JSON.stringify(step)}`);
      const objectId = await this.evaluate(`globalThis.${PAGE_GLOBAL}.frameElement()`, await this.engineContext(frameId), frameId, 5000, false);
      if (typeof objectId !== 'string') throw new ActionError('frame_unreachable', 'Frame owner disappeared');
      const parentSession = this.sessionFor(frameId);
      try {
        const { node } = await this.send('DOM.describeNode', { objectId }, this.sessionFor(frameId));
        if (!node.frameId) throw new ActionError('frame_unreachable', 'Frame is not ready');
        offset.x += probe.x; offset.y += probe.y;
        frameId = node.frameId;
      } finally {
        await this.send('Runtime.releaseObject', { objectId }, parentSession).catch(() => {});
      }
    }
    return { frameId, offset };
  }
  async pageCall(fn: string, args?: unknown, timeoutMs?: number, frame?: FrameStep | FrameStep[]): Promise<unknown> {
    return this.callIn((await this.route(frame)).frameId, fn, args, timeoutMs);
  }
  async evaluateMain(expression: string, frame?: FrameStep | FrameStep[], timeoutMs?: number): Promise<unknown> {
    if (!frameSteps(frame).length) return this.evaluate(expression, undefined, undefined, timeoutMs);
    const { frameId } = await this.route(frame);
    await this.send('Runtime.enable', {}, this.sessionFor(frameId));
    const contextId = this.mainContexts.get(frameId);
    if (contextId === undefined) throw new ActionError('frame_unreachable', 'Frame main world is not ready');
    return this.evaluate(expression, contextId, frameId, timeoutMs);
  }
  async startCapture(pattern = ''): Promise<void> { await this.ready(); this.capturePattern = pattern; }
  async readCapture(): Promise<unknown[]> {
    await Promise.all([...this.bodies]);
    const entries: unknown[] = [];
    for (const [id, entry] of this.network) if (entry.finished) { entries.push(entry); this.network.delete(id); }
    return entries;
  }
  async frames() {
    await this.ready();
    const { frameTree } = await this.send('Page.getFrameTree');
    return (frameTree.childFrames ?? []).map((child: any, index: number) => ({ index, frameId: child.frame.id, name: child.frame.name ?? '', url: child.frame.url }));
  }
  async act(spec: ActSpec) {
    const { frameId, offset } = await this.route(spec.target.frame, true);
    return performAct({
      call: (fn, args, timeout) => this.callIn(frameId, fn, args, timeout),
      cdp: (method, params) => this.send(method, params),
      pointOffset: offset,
      setFiles: async files => {
        const objectId = await this.evaluate(`globalThis.${PAGE_GLOBAL}.actionTarget()`, await this.engineContext(frameId), frameId, 5000, false);
        try { await this.send('DOM.setFileInputFiles', { objectId, files }, this.sessionFor(frameId)); }
        finally { await this.send('Runtime.releaseObject', { objectId }, this.sessionFor(frameId)).catch(() => {}); }
      },
      waitForNavigation: async (classifyMs, timeoutMs) => {
        const before = this.contents.getURL();
        await new Promise(resolve => setTimeout(resolve, classifyMs));
        const navigated = this.contents.isLoadingMainFrame() || this.contents.getURL() !== before;
        const deadline = Date.now() + timeoutMs;
        while (!this.contents.isDestroyed() && this.contents.isLoadingMainFrame() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        return { navigated, url: this.contents.isDestroyed() ? undefined : this.contents.getURL() };
      },
    }, spec);
  }
  dispose(detach = true): void {
    if (this.disposed) return;
    this.disposed = true;
    this.contents.debugger.removeListener('message', this.onMessage);
    this.contents.debugger.removeListener('detach', this.onDetach);
    if (detach && this.attached && !this.contents.isDestroyed() && this.contents.debugger.isAttached()) this.contents.debugger.detach();
    this.attached = false; this.contexts.clear(); this.targets.clear();
  }
}
