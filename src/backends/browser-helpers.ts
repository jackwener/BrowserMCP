// Adapted from OpenCLI 1.8.7 (https://github.com/jackwener/opencli), Apache-2.0.
// Kept only the page scripts used by browsermcp; see LICENSE.

/**
 * Wrap JS code for CDP Runtime.evaluate:
 * - Already an IIFE `(...)()` → send as-is
 * - Arrow/function literal → wrap as IIFE `(code)()`
 * - `new Promise(...)` or raw expression → send as-is (expression)
 */
export function wrapForEval(js: string): string {
    if (typeof js !== 'string')
        return 'undefined';
    const code = js.trim();
    if (!code)
        return 'undefined';
    // Already an IIFE: `(async () => { ... })()` or `(function() {...})()`
    if (/^\([\s\S]*\)\s*\(.*\)\s*$/.test(code))
        return code;
    // Arrow function: `() => ...` or `async () => ...`
    if (/^(async\s+)?(\([^)]*\)|[A-Za-z_]\w*)\s*=>/.test(code))
        return `(${code})()`;
    // Function declaration: `function ...` or `async function ...`
    if (/^(async\s+)?function[\s(]/.test(code))
        return `(${code})()`;
    // Everything else: bare expression, `new Promise(...)`, etc. → evaluate directly
    return code;
}

/** Generate JS to read performance resource entries as network requests */
export function networkRequestsJs(includeStatic: boolean): string {
    return `
    (() => {
      const entries = performance.getEntriesByType('resource');
      return entries
        ${includeStatic ? '' : '.filter(e => !["img", "font", "css", "script"].some(t => e.initiatorType === t))'}
        .map(e => ({
          url: e.name,
          type: e.initiatorType,
          duration: Math.round(e.duration),
          size: e.transferSize || 0,
        }));
    })()
  `;
}
/**
 * Generate JS to wait until the DOM stabilizes (no mutations for `quietMs`),
 * with a hard cap at `maxMs`. Uses MutationObserver in the browser.
 *
 * Returns as soon as the page stops changing, avoiding unnecessary fixed waits.
 * If document.body is not available, falls back to a fixed sleep of maxMs.
 */
export function waitForDomStableJs(maxMs: number, quietMs: number): string {
    return `
    new Promise(resolve => {
      if (!document.body) {
        setTimeout(() => resolve('nobody'), ${maxMs});
        return;
      }
      let timer = null;
      let cap = null;
      const done = (reason) => {
        clearTimeout(timer);
        clearTimeout(cap);
        obs.disconnect();
        resolve(reason);
      };
      const resetQuiet = () => {
        clearTimeout(timer);
        timer = setTimeout(() => done('quiet'), ${quietMs});
      };
      const obs = new MutationObserver(resetQuiet);
      obs.observe(document.body, { childList: true, subtree: true, attributes: true });
      resetQuiet();
      cap = setTimeout(() => done('capped'), ${maxMs});
    })
  `;
}
