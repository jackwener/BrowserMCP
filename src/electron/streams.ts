import { randomUUID } from 'node:crypto';
import { EventBuffer } from './event-buffer.js';
import { ActionError } from '../api/errors.js';
import type { BrowserEvent, StreamReadOptions } from '../protocol.js';

const events = new Set(['tabs.onCreated', 'tabs.onUpdated', 'tabs.onRemoved', 'tabs.onActivated']);

/** Each subscription belongs to one authorized session, including all reads and closes. */
export class ElectronStreams {
  private readonly streams = new Map<string, { session: string; event: string; buffer: EventBuffer }>();
  watch(session: string, event: string, capacity = 500) {
    if (!events.has(event)) throw new ActionError('capability_unavailable', `Chrome event ${event} is not supported`);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) throw new ActionError('invalid_args', 'capacity must be between 1 and 1000');
    if ([...this.streams.values()].filter(stream => stream.session === session).length >= 32) throw new ActionError('resource_limit', 'Session subscription limit reached');
    const id = randomUUID(), buffer = new EventBuffer(capacity);
    this.streams.set(id, { session, event, buffer });
    return { id, cursor: buffer.cursor() };
  }
  private get(session: string, id: string) {
    const stream = this.streams.get(id);
    if (!stream || stream.session !== session) throw new ActionError('stream_closed', 'Subscription is closed or belongs to another session');
    return stream;
  }
  read(session: string, id: string, options?: StreamReadOptions) { return this.get(session, id).buffer.read(options); }
  close(session: string, id: string) { this.get(session, id); this.streams.delete(id); }
  reset(session: string) { for (const [id, stream] of this.streams) if (stream.session === session) this.streams.delete(id); }
  emit(session: string, event: string, args: unknown[]) {
    for (const stream of this.streams.values()) if (stream.session === session && stream.event === event) stream.buffer.push({ event, args });
  }
  browserEvent(event: BrowserEvent) {
    if (!('session' in event) || !('tabId' in event)) return;
    const tab = { id: event.tabId, url: event.url, title: event.title };
    if (event.kind === 'tab_created') this.emit(event.session, 'tabs.onCreated', [tab]);
    if (event.kind === 'tab_navigated') this.emit(event.session, 'tabs.onUpdated', [event.tabId, { url: event.url }, tab]);
    if (event.kind === 'tab_closed') this.emit(event.session, 'tabs.onRemoved', [event.tabId, { windowId: -1, isWindowClosing: false }]);
  }
  dispose() { this.streams.clear(); }
}
