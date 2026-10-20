import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Runtime } from '../src/runtime/runtime.js';
import type { RuntimePage } from '../src/backends/page-types.js';

// Page execution is covered separately; here the real adapter loader and draft lifecycle run on disk.
function provision(dir: string) {
  const runtime = new Runtime({ userAdaptersDir: path.join(dir, 'adapters') });
  runtime.browserAvailable = () => true;
  runtime.getAdapterPage = async () => ({}) as RuntimePage;
  runtime.toolContext = async () => ({ tab: {}, sites: {}, recon: {} });
  return runtime;
}

describe('host-owned adapter storage', () => {
  it('creates, verifies, updates, reloads and removes adapters without sharing another application storage', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'embedded-adapters-'));
    const first = provision(path.join(root, 'first'));
    const second = provision(path.join(root, 'second'));
    let restarted: Runtime | undefined;
    try {
      await first.init(); await second.init();
      const define = (value: number) => first.defineTool({ site: 'demo', name: 'value', description: 'Host adapter', access: 'read', func: `async () => ({ value: ${value} })` });
      const original = await define(1);
      await expect(second.activateToolDraft(original.draftId)).rejects.toMatchObject({ code: 'unknown_draft' });
      await expect(first.activateToolDraft(original.draftId)).rejects.toMatchObject({ code: 'draft_not_verified' });
      expect((await first.tryToolDraft(original.draftId, {}, { path: 'value.value', equals: 1 })).verification.passed).toBe(true);
      await first.activateToolDraft(original.draftId);
      expect(await first.runSite('demo', 'value', {})).toMatchObject({ ok: true, value: { value: 1 } });
      const updated = await define(2);
      expect(await first.runSite('demo', 'value', {})).toMatchObject({ ok: true, value: { value: 1 } });
      await first.tryToolDraft(updated.draftId, {}, { path: 'value.value', equals: 2 });
      await first.activateToolDraft(updated.draftId);
      expect(await first.runSite('demo', 'value', {})).toMatchObject({ ok: true, value: { value: 2 } });
      expect(second.listTools()).toEqual([]);
      expect(second.registry.sites()).toEqual([]);
      restarted = provision(path.join(root, 'first'));
      await restarted.init();
      expect(await restarted.runSite('demo', 'value', {})).toMatchObject({ ok: true, value: { value: 2 } });
      expect(await restarted.removeTool('demo', 'value')).toBe(true);
      expect(restarted.listTools()).toEqual([]);
      await expect(restarted.removeTool('../outside', 'value')).rejects.toMatchObject({ code: 'invalid_definition' });
    } finally {
      await first.shutdown(); await second.shutdown(); await restarted?.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
