import type { RuntimePage } from './page-types.js';
import type { CloseUserTabsResult } from '../protocol.js';

export interface PageOptions {
  session: string;
  surface: 'browser' | 'adapter';
  /** bind this page object to one tab identity for its whole life (per-Tab pages); omitted = session-scope page with no tab */
  page?: string;
}

export interface UserTabInfo { tabId: number; title?: string; url?: string; windowId: number; active: boolean; groupId?: number; lastAccessed?: number }

/** Page ownership and lifecycle operations shared by browser backends. */
export interface ManagedPageExtras {
  nameSession(name: string): Promise<void>;
  userTabs(options?: { query?: string; limit?: number }): Promise<UserTabInfo[]>;
  claim(tab: { tabId?: number; active?: boolean; title?: string; url?: string; expectedUrl?: string; expectedTitle?: string }): Promise<{ page: string; tabId: number; url?: string; title?: string }>;
  closeUserTabs(tabIds: number[]): Promise<CloseUserTabsResult>;
  mark(page: string, mark: 'deliverable' | 'handoff' | null): Promise<void>;
  finalize(keep: Array<{ page: string; status: 'deliverable' | 'handoff' }>): Promise<{ closed: string[]; kept: string[]; failed: Array<{ page: string; reason: string }> }>;
  cursor(x: number, y: number, opts?: { waitForArrival?: boolean }): Promise<void>;
  setVisibility(visible: boolean): Promise<void>;
  getVisibility(): Promise<boolean>;
}

export type ManagedRuntimePage = RuntimePage & ManagedPageExtras;
