import type { Command, BrowserFeature } from '../protocol.js';

export interface PageTransport {
  readonly extensionFeatures: BrowserFeature[];
  send(action: Command['action'], params?: Omit<Command, 'id' | 'action'>, opts?: { timeoutMs?: number }): Promise<{ data: unknown; page?: string }>;
}
