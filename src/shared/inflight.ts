/**
 * Requests in flight on one page, for the post-action settle. Fed by the page session's Network.* events. Only requests
 * that start after an action count for it, so long polls and analytics beacons that were already open never hold an
 * action. Streams and fire-and-forget types never finish or never matter.
 */
const IGNORED_TYPES = new Set(['WebSocket', 'EventSource', 'Media', 'Ping', 'Manifest', 'Prefetch', 'CSPViolationReport', 'Preflight']);
/** A request with no end event after this long is dropped (a hung connection must not leak). */
const FORGET_MS = 60_000;

export class InflightRequests {
  private readonly started = new Map<string, number>();
  private lastEventAt = 0;

  note(method: string, params: { requestId?: string; type?: string } | undefined): void {
    const requestId = String(params?.requestId ?? '');
    if (!requestId) return;
    const now = Date.now();
    if (method === 'Network.requestWillBeSent') {
      if (params?.type && IGNORED_TYPES.has(params.type)) return;
      // A redirect re-sends the same requestId: keep the original start.
      if (!this.started.has(requestId)) this.started.set(requestId, now);
      this.lastEventAt = now;
      if (this.started.size > 500) this.forgetHung(now);
      return;
    }
    if (!this.started.has(requestId)) return;
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') this.started.delete(requestId);
    this.lastEventAt = now;
  }

  /** Requests started at or after `since` (Date.now() ms) still in flight, and ms since the last request event. */
  activity(since: number): { pending: number; idleMs: number } {
    const now = Date.now();
    this.forgetHung(now);
    let pending = 0;
    for (const at of this.started.values()) if (at >= since) pending++;
    return { pending, idleMs: now - Math.max(since, this.lastEventAt) };
  }

  private forgetHung(now: number): void {
    for (const [id, at] of this.started) if (now - at > FORGET_MS) this.started.delete(id);
  }
}
