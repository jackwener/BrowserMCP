import type { DomEntry } from '../src/shared/page-contract.js';
import { expect, it } from 'vitest';
import { observationPage, OBSERVATION_BUDGET } from '../src/api/observation.js';
import { compactAria } from '../src/shared/aria-tree.js';
import type { ObserveResult } from '../src/api/tab.js';

it('pages one capture across ARIA, oversized text and frame DOM without losing evidence', () => {
  const state = '- region "Results":\n' + Array.from({ length: 600 }, (_, i) => `  - button "Item ${i}" [ref=e${i}]\n`).join('') + '- text "' + '😀\\"'.repeat(5000) + '"';
  const entries = Array.from({ length: 100 }, (_, i) => ({ ref: `e${i}`, tag: 'input', text: 'Field', attrs: { value: 'x'.repeat(200) }, truncated: false }));
  const capture: ObserveResult = { url: 'data:text/html,' + 'x'.repeat(20000), title: 'Test', snapshotId: '1', state, framesComplete: false, frames: [
    { frame: ['#child'], owner: { ref: 'e1', id: 'child', name: '', src: '' }, dom: { entries, start: 0, total: 110, nextStart: 100, scope: 'document' } },
    { frame: ['#missing'], owner: { ref: 'e2', id: 'missing', name: '', src: '' }, unavailable: 'Capture failed' },
  ] };
  let cursor: string | undefined;
  let text = '', found: DomEntry[] = [], missing = false, fragmented = false;
  const seen = new Set<string>();
  do {
    const page = observationPage(capture, cursor);
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(OBSERVATION_BUDGET);
    expect(page.framesComplete).toBe(false);
    expect(page.metadataTruncated).toBe(true);
    expect(page.complete).toBe(!page.nextCursor);
    text += page.state ?? '';
    fragmented ||= page.stateContinues === true;
    for (const frame of page.frames ?? []) {
      if (frame.dom) { expect(frame.dom.start).toBe(found.length); found.push(...frame.dom.entries); }
      if (frame.unavailable) missing = true;
    }
    cursor = page.nextCursor;
    if (cursor) { expect(seen.has(cursor)).toBe(false); seen.add(cursor); }
  } while (cursor);
  expect(text).toBe(state);
  expect(found).toEqual(entries);
  expect(missing && fragmented).toBe(true);
  expect(() => observationPage(capture, '2:0:0')).toThrow(/cursor/);
});

it('compacts only inert wrappers, preserving names, states, refs and sibling hierarchy', () => {
  expect(compactAria('- generic:\n  - group:\n    - button "Save" [ref=e1]\n    - text: Invalid name\n  - group "Billing":\n    - checkbox "Default" [checked] [ref=e2]\n- generic [ref=e3]:\n  - button "More" [ref=e4]')).toBe('- button "Save" [ref=e1]\n- text: Invalid name\n- group "Billing":\n  - checkbox "Default" [checked] [ref=e2]\n- generic [ref=e3]:\n  - button "More" [ref=e4]');
});
