/**
 * ExtensionBridge — request/response + events over a NativeChannel.
 * One bridge per connected extension (Chrome profile). The runtime talks to
 * pages exclusively through `send(action, params)`.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { NativeChannel } from './native-messaging.js';
import { PROTOCOL_REVISION, type Action, type BrowserEvent, type BrowserFeature, type Command, type ExtToHost, type Result } from '../protocol.js';

export class BrowserCommandError extends Error {
  constructor(message: string, readonly code: string = 'browser_command_failed', readonly hint?: string, readonly data?: unknown) {
    super(message);
    this.name = 'BrowserCommandError';
  }
}

type Pending = { resolve: (r: Result) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export interface BridgeEvents {
  hello: [Extract<ExtToHost, { type: 'hello' }>];
  event: [BrowserEvent];
  close: [];
}

export class ExtensionBridge extends EventEmitter<BridgeEvents> {
  private readonly pending = new Map<string, Pending>();
  extensionVersion: string | null = null;
  browserId: string | null = null;
  protocolRevision: number | null = null;
  extensionFeatures: BrowserFeature[] = [];
  connected = false;
  get protocolMatches(): boolean { return this.connected && this.protocolRevision === PROTOCOL_REVISION; }
  get protocolWarning(): string | null {
    if (!this.connected || this.protocolMatches) return null;
    return `Extension protocol ${this.protocolRevision ?? 'unknown'} differs from host protocol ${PROTOCOL_REVISION}. Browser commands are blocked; update the host and extension together.`;
  }

  /** Set by the host so the extension learns its running version (informational). */
  ready: { version: string } | null = null;
  /** Push the ready frame now (used when hello arrived before the host finished starting). */
  sendReady(): void { if (this.ready && this.connected) { try { this.channel.send({ type: 'ready', ...this.ready }); } catch { /* ignore */ } } }

  constructor(private readonly channel: NativeChannel) {
    super();
    channel.on('message', (raw) => this.onMessage(raw as ExtToHost));
    channel.on('close', () => {
      this.connected = false;
      this.protocolRevision = null;
      this.extensionFeatures = [];
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new BrowserCommandError('extension disconnected', 'extension_disconnected'));
        this.pending.delete(id);
      }
      this.emit('close');
    });
  }

  private onMessage(msg: ExtToHost): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') {
      this.connected = true;
      this.browserId = msg.browserId;
      this.extensionVersion = msg.extensionVersion;
      this.protocolRevision = msg.protocolRevision ?? null;
      this.extensionFeatures = Array.isArray(msg.features) ? msg.features : [];
      if (this.ready) { try { this.channel.send({ type: 'ready', ...this.ready }); } catch { /* ignore */ } }
      this.emit('hello', msg);
      return;
    }
    if (msg.type === 'result') {
      const p = this.pending.get(msg.result.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.result.id);
      p.resolve(msg.result);
      return;
    }
    if (msg.type === 'event') this.emit('event', msg.event);
  }

  private probePending: Promise<boolean> | null = null;
  /** A fresh extension round trip; concurrent discovery and lifecycle checks share it. */
  probe(): Promise<boolean> {
    if (!this.connected) return Promise.resolve(false);
    if (!this.probePending) this.probePending = this.send('ping', {}, { timeoutMs: 2000 })
      .then(result => (result.data as { pong?: boolean })?.pong === true, () => false)
      .finally(() => { this.probePending = null; });
    return this.probePending;
  }

  /** Send a command; resolves with `data`, throws BrowserCommandError on `ok:false`. */
  async send(action: Action, params: Omit<Command, 'id' | 'action'> = {}, opts: { timeoutMs?: number } = {}): Promise<{ data: unknown; page?: string }> {
    if (action !== 'ping' && this.connected && !this.protocolMatches) throw new BrowserCommandError(this.protocolWarning!, 'protocol_mismatch', 'Update the host and extension together. This command was not dispatched.');
    const timeoutMs = opts.timeoutMs ?? (params.timeoutMs ?? 60_000) + 5_000;
    const id = randomUUID();
    const command: Command = { id, action, ...params, deadlineAt: Date.now() + timeoutMs };
    const result = await new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserCommandError(`${action} timed out after ${Math.round(timeoutMs / 1000)}s`, 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.channel.send({ type: 'command', command });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
    if (!result.ok) throw new BrowserCommandError(result.error ?? `${action} failed`, result.errorCode ?? 'browser_command_failed', result.errorHint ?? (result.errorCode === 'unknown_action' && this.protocolWarning ? 'The connected extension does not support this action; check doctor and update the host or extension if needed.' : undefined), result.data);
    return { data: result.data, page: result.page };
  }
}
