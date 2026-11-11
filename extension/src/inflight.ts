/**
 * Requests in flight per tab, for the post-action settle. Fed by Network.* events of the tab's own session (the page
 * and its in-process frames). Only requests that start after an action count for it, so long polls and analytics
 * beacons that were already open never hold an action. Streams and fire-and-forget types never finish or never matter.
 */
const IGNORED_TYPES = new Set(['WebSocket', 'EventSource', 'Media', 'Ping', 'Manifest', 'Prefetch', 'CSPViolationReport', 'Preflight']);
/** A request with no end event after this long is dropped (a hung connection must not leak). */
const FORGET_MS = 60_000;

interface TabRequests { started: Map<string, number>; lastEventAt: number }
const tabs = new Map<number, TabRequests>();

export function noteNetworkEvent(tabId: number, method: string, params: { requestId?: string; type?: string } | undefined): void {
  const requestId = String(params?.requestId ?? '');
  if (!requestId) return;
  let state = tabs.get(tabId);
  if (method === 'Network.requestWillBeSent') {
    if (params?.type && IGNORED_TYPES.has(params.type)) return;
    if (!state) tabs.set(tabId, state = { started: new Map(), lastEventAt: 0 });
    const now = Date.now();
    // A redirect re-sends the same requestId: keep the original start.
    if (!state.started.has(requestId)) state.started.set(requestId, now);
    state.lastEventAt = now;
    if (state.started.size > 500) for (const [id, at] of state.started) if (now - at > FORGET_MS) state.started.delete(id);
    return;
  }
  if (!state || !state.started.has(requestId)) return;
  if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') state.started.delete(requestId);
  state.lastEventAt = Date.now();
}

/** Requests started at or after `since` (Date.now() ms) still in flight, and ms since the last event of any of them. */
export function networkActivity(tabId: number, since: number): { pending: number; idleMs: number } {
  const state = tabs.get(tabId);
  const now = Date.now();
  if (!state) return { pending: 0, idleMs: now - since };
  let pending = 0;
  for (const [id, at] of state.started) {
    if (now - at > FORGET_MS) { state.started.delete(id); continue; }
    if (at >= since) pending++;
  }
  return { pending, idleMs: now - Math.max(since, state.lastEventAt) };
}

export function forgetTab(tabId: number): void { tabs.delete(tabId); }
