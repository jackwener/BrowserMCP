/**
 * Native Messaging framing over stdio: 4-byte little-endian length prefix + UTF-8 JSON.
 * Chrome spawns the host and owns stdin/stdout; everything we log goes to stderr.
 */
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { MAX_FRAME_BYTES } from '../protocol.js';

export function encodeFrame(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  if (json.length > MAX_FRAME_BYTES) {
    throw new Error(`native messaging frame too large: ${json.length} bytes (max ${MAX_FRAME_BYTES})`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/** Incremental decoder: feed chunks, get complete messages. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  onBadFrame: ((err: Error, preview: string) => void) | null = null;
  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: unknown[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len).toString('utf8');
      this.buf = this.buf.subarray(4 + len);
      try { out.push(JSON.parse(body)); } catch (err) { this.onBadFrame?.(err as Error, body.slice(0, 200)); }
    }
    return out;
  }
}

export interface NativeChannelEvents {
  message: [unknown];
  close: [];
  error: [Error];
}

/** Bidirectional Native Messaging channel on a pair of streams (stdin/stdout by default). */
export class NativeChannel extends EventEmitter<NativeChannelEvents> {
  private readonly decoder = new FrameDecoder();
  private closed = false;
  constructor(input: Readable, private readonly output: Writable) {
    super();
    this.decoder.onBadFrame = (err, preview) => this.emit('error', new Error(`bad native frame: ${err.message} (${preview})`));
    input.on('data', (chunk: Buffer) => {
      let messages: unknown[];
      try { messages = this.decoder.push(chunk); } catch (err) { this.emit('error', err as Error); return; }
      for (const m of messages) this.emit('message', m);
    });
    input.on('end', () => this.close());
    input.on('close', () => this.close());
    input.on('error', (err) => this.emit('error', err));
  }
  send(message: unknown): void {
    if (this.closed) throw new Error('native channel closed');
    this.output.write(encodeFrame(message));
  }
  get isClosed(): boolean { return this.closed; }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}
