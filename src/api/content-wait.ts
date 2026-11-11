/**
 * After a navigation finishes loading, wait until the page shows its content. Script-rendered pages are still empty
 * at the load event, so an observe or read right after tabs.new/goto returned nothing and the agent had to spend a
 * turn waiting and reading again. Rules, each from a measured failure (cindy's browser-use notes, reproduced here):
 * - only the document's own location counts: a new tab shows the browser's placeholder page while the tab already
 *   reports the target URL, and internal pages (about:, chrome:) are never the target;
 * - plenty of text (>= 1500 characters) is enough;
 * - shorter text must keep its length for two probes (headers and footers render before the body), four while the
 *   document is still parsing with under 200 characters;
 * - a "Loading…" / "Just a moment..." placeholder gets up to 3 s to turn into something else;
 * - a loaded page that never shows text (blank, an image) is released after 2 s.
 * Best effort and bounded: it never fails the navigation, and it says only that the page is not empty, not that its
 * asynchronous data has all arrived.
 */
import type { ContentProbe } from '../shared/page-contract.js';

const INTERVAL_MS = 250;
const ENOUGH_CHARS = 1500;
const SHORT_CHARS = 200;
const BLANK_RELEASE_MS = 2000;
const PLACEHOLDER_MS = 3000;
export const CONTENT_WAIT_MS = 5000;
const PLACEHOLDER = /(?:^|\s)(?:loading|please wait|just a moment|one moment|redirecting|checking your browser)\b|加载中|正在加载|请稍候|(?:\.\.\.|…)$/i;

export type ContentState = 'ready' | 'empty' | 'placeholder' | 'unknown';

export async function waitForContent(probe: () => Promise<ContentProbe>, budgetMs = CONTENT_WAIT_MS): Promise<ContentState> {
  const started = Date.now();
  let previous = -1, same = 0, failures = 0, last: ContentProbe | null = null;
  let loadedAt: number | null = null, placeholderSince: number | null = null;
  for (;;) {
    try { last = await probe(); failures = 0; }
    catch { last = null; if (++failures >= 4) return 'unknown'; } // navigating: the next document has no world yet
    const now = Date.now();
    if (last && !/^(?:about|chrome|chrome-error|edge|brave):/i.test(last.href)) {
      if (last.ready === 'complete') loadedAt ??= now;
      if (last.chars >= ENOUGH_CHARS) return 'ready';
      same = last.chars === previous ? same + 1 : 0;
      previous = last.chars;
      const placeholder = last.chars > 0 && last.chars < SHORT_CHARS && PLACEHOLDER.test(last.head);
      placeholderSince = placeholder ? placeholderSince ?? now : null;
      if (placeholder) { if (now - placeholderSince! >= PLACEHOLDER_MS) return 'placeholder'; }
      else if (last.chars === 0) { if (loadedAt !== null && now - loadedAt >= BLANK_RELEASE_MS) return 'empty'; }
      else if (same >= (last.ready !== 'complete' && last.chars < SHORT_CHARS ? 3 : 1)) return 'ready';
    }
    if (now - started + INTERVAL_MS > budgetMs) return !last ? 'unknown' : placeholderSince !== null ? 'placeholder' : last.chars > 0 ? 'ready' : 'empty';
    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
  }
}
