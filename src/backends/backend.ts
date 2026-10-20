import type { BrowserEvent, BrowserFeature, Command } from '../protocol.js';
import type { PageOptions, ManagedRuntimePage } from './managed-page.js';

/** Host-owned browser access. No discovery, installation, or process lifecycle. */
export interface BrowserBackend {
  readonly kind: 'electron' | 'extension';
  readonly available: boolean;
  features(): BrowserFeature[];
  createPage(options: PageOptions): Promise<ManagedRuntimePage>;
  subscribe(listener: (event: BrowserEvent) => void): () => void;
  command?(action: Command['action'], params: Partial<Command>): Promise<{ data: unknown }>;
  dispose(): Promise<void>;
}
