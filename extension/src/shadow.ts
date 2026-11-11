/** Closed shadow roots for the engine world of one frame (see src/shared/closed-shadow.ts). */
import { adoptClosedShadowRoots } from '../../src/shared/closed-shadow';
import { evaluateInWorld, frameCommand, engineContextId } from './world';

export function exposeClosedShadowRoots(tabId: number, frameId: string | null, aggressive: boolean): Promise<number> {
  return adoptClosedShadowRoots({
    evaluateHandle: async expression => await evaluateInWorld(tabId, frameId, expression, aggressive, 5_000, false) as string | undefined,
    cdp: (method, params) => frameCommand(tabId, frameId, method, params, aggressive, 5_000),
    engineContextId: () => engineContextId(tabId, frameId, aggressive),
  });
}
