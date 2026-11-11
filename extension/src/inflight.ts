/** Requests in flight per tab (see src/shared/inflight.ts), fed by Network.* events of each tab's own session. */
import { InflightRequests } from '../../src/shared/inflight';

const tabs = new Map<number, InflightRequests>();

export function noteNetworkEvent(tabId: number, method: string, params: { requestId?: string; type?: string } | undefined): void {
  let requests = tabs.get(tabId);
  if (!requests) tabs.set(tabId, requests = new InflightRequests());
  requests.note(method, params);
}

export function networkActivity(tabId: number, since: number): { pending: number; idleMs: number } {
  return tabs.get(tabId)?.activity(since) ?? { pending: 0, idleMs: Date.now() - since };
}

export function forgetTab(tabId: number): void { tabs.delete(tabId); }
