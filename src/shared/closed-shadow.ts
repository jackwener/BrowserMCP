/**
 * Hand closed shadow roots to the engine world (see closedShadowCandidates/adoptShadowRoot in the page module).
 * Shared by every backend that owns a CDP session for the frame: the extension and the embedded Electron driver.
 */
import { PAGE_GLOBAL } from './page-contract.js';

export interface ShadowIO {
  /** Evaluate in the frame's engine world and return a remote object id (undefined for null/undefined results). */
  evaluateHandle(expression: string): Promise<string | undefined>;
  /** A CDP command on the session that owns the frame. */
  cdp(method: string, params: Record<string, unknown>): Promise<any>;
  /** The engine world's execution context id on that session. */
  engineContextId(): Promise<number>;
}

/** Nested closed roots appear only after their parent root is adopted. */
const MAX_ROUNDS = 4;

/** Adopt the closed shadow roots of new candidate hosts. Returns how many were adopted; never throws. */
export async function adoptClosedShadowRoots(io: ShadowIO): Promise<number> {
  let adopted = 0;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const list = await io.evaluateHandle(`(() => { const c = globalThis.${PAGE_GLOBAL}.closedShadowCandidates?.(); return c && c.length ? c : null; })()`);
      if (!list) break;
      let found = 0;
      const handles: string[] = [list];
      try {
        const { result } = await io.cdp('Runtime.getProperties', { objectId: list, ownProperties: true }) as { result: Array<{ name: string; value?: { objectId?: string } }> };
        const hosts = result.filter(p => /^\d+$/.test(p.name) && p.value?.objectId).map(p => p.value!.objectId!);
        handles.push(...hosts);
        let context: number | undefined;
        for (const host of hosts) {
          const { node } = await io.cdp('DOM.describeNode', { objectId: host, depth: 0, pierce: true }) as { node: { shadowRoots?: Array<{ backendNodeId: number; shadowRootType?: string }> } };
          for (const root of node.shadowRoots ?? []) {
            if (root.shadowRootType !== 'closed') continue;
            context ??= await io.engineContextId();
            const { object } = await io.cdp('DOM.resolveNode', { backendNodeId: root.backendNodeId, executionContextId: context }) as { object: { objectId?: string } };
            if (!object.objectId) continue;
            handles.push(object.objectId);
            const r = await io.cdp('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function () { return globalThis.${PAGE_GLOBAL}.adoptShadowRoot(this); }`, returnByValue: true }) as { result?: { value?: unknown } };
            if (r.result?.value === true) found++;
          }
        }
      } finally {
        await Promise.all(handles.map(objectId => io.cdp('Runtime.releaseObject', { objectId }).catch(() => {})));
      }
      adopted += found;
      if (!found) break;
    }
  } catch { /* best effort: a page without access or a navigating frame keeps working without closed roots */ }
  return adopted;
}
