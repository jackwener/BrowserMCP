/** Object-model action validation shared by REPL sessions and adapters. */
import { ActionError } from './errors.js';
import { z } from 'zod';
import type { Expectation } from '../shared/page-contract.js';
import type { ActAction, Target } from './tab.js';

export interface RawTarget {
  ref?: string | number;
  selector?: string;
  within?: string;
  nth?: number;
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  testid?: string;
  x?: number;
  y?: number;
  frame?: Target['frame'];
}

export interface ActToolInput {
  action: ActAction;
  target?: RawTarget;
  to?: RawTarget;
  value?: string;
  files?: string[];
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  method?: 'cdp' | 'dom';
  timeoutMs?: number;
  settleMs?: number;
}

const frame = z.union([z.string(), z.number().int()]);
export const targetShape = z.object({
  ref: z.union([z.string(), z.number().int()]).optional(),
  selector: z.string().optional(), within: z.string().optional(), nth: z.number().int().optional(),
  role: z.string().optional(), name: z.string().optional(), label: z.string().optional(), text: z.string().optional(), testid: z.string().optional(),
  x: z.number().optional(), y: z.number().optional(), frame: z.union([frame, z.array(frame)]).optional(),
}).strict();
const actionShape = z.object({
  action: z.string(), target: targetShape.optional(), to: targetShape.optional(), value: z.string().optional(),
  files: z.array(z.string().min(1)).optional(), direction: z.enum(['up', 'down', 'left', 'right']).optional(), amount: z.number().optional(),
  timeoutMs: z.number().int().nonnegative().optional(), settleMs: z.number().int().min(0).max(10_000).optional(), method: z.enum(['cdp', 'dom']).optional(),
}).strict();
const expectationShape = z.object({ target: targetShape.optional(), text: z.string().min(1).optional(), notText: z.string().min(1).optional(), url: z.string().min(1).optional(), title: z.string().min(1).optional(), visible: z.boolean().optional(), value: z.string().optional(), checked: z.boolean().optional(), selected: z.array(z.string()).optional(), enabled: z.boolean().optional() }).strict();

function validate(shape: z.ZodType, value: unknown): void {
  const result = shape.safeParse(value);
  if (!result.success) throw new ActionError('invalid_args', result.error.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '), 'Read docs_get with name:"api-reference" and member:"Tab.act" or "Tab.expect" for exact fields.');
}

type Need = 'required' | 'nonempty' | 'present' | 'optional' | 'forbidden';

export const ACTION_RULES: Record<ActAction, { target: Need; value: Need; files: Need; to: Need; scroll: boolean }> = {
  click: { target: 'required', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
  dblclick: { target: 'required', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
  hover: { target: 'required', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
  focus: { target: 'required', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
  check: { target: 'required', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
  uncheck: { target: 'required', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
  fill: { target: 'required', value: 'present', files: 'forbidden', to: 'forbidden', scroll: false },
  type: { target: 'required', value: 'nonempty', files: 'forbidden', to: 'forbidden', scroll: false },
  press: { target: 'required', value: 'nonempty', files: 'forbidden', to: 'forbidden', scroll: false },
  select: { target: 'required', value: 'nonempty', files: 'forbidden', to: 'forbidden', scroll: false },
  upload: { target: 'required', value: 'forbidden', files: 'required', to: 'forbidden', scroll: false },
  drag: { target: 'required', value: 'forbidden', files: 'forbidden', to: 'required', scroll: false },
  scroll: { target: 'optional', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: true },
  back: { target: 'forbidden', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
  forward: { target: 'forbidden', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
  reload: { target: 'forbidden', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
};

const TARGET_HELP = 'Exactly one of {ref}, {selector}, {role, name?}, {name}, {label}, {text}, {testid}, or {x,y}. frame, within, and nth narrow a non-point locator.';

/** What the model can copy into the next call. Wire shape is error.details.expected. */
export function expectedAct(action: ActAction): Record<string, string> {
  const rule = ACTION_RULES[action];
  return {
    action,
    target: rule.target === 'forbidden' ? 'forbidden' : rule.target === 'optional' ? `optional. ${TARGET_HELP}` : `required. ${TARGET_HELP}`,
    value: rule.value === 'forbidden' ? 'forbidden' : rule.value === 'present' ? 'string, required; "" clears the field' : rule.value === 'optional' ? 'optional string' : 'non-empty string, required',
    files: rule.files === 'required' ? 'non-empty string[], required' : 'forbidden',
    to: rule.to === 'required' ? `required. ${TARGET_HELP}` : 'forbidden',
    direction: rule.scroll ? 'optional up|down|left|right (default down)' : 'forbidden',
    amount: rule.scroll ? 'optional number (default 600)' : 'forbidden',
    method: action === 'click' ? 'optional cdp|dom. dom runs HTMLElement.click() and sends no mouse event. Only after not_delivered or no box.' : 'forbidden',
  };
}

function reject(action: ActAction, message: string): never {
  throw new ActionError('invalid_args', message, 'Copy expected and send only those fields.', { details: { expected: expectedAct(action) } });
}

/** `name` only modifies `role`. Any other pair of these is two locators. */
function semanticKeys(t: RawTarget): string[] {
  const keys: string[] = [];
  if (t.role) keys.push('role');
  if (t.label) keys.push('label');
  if (t.text) keys.push('text');
  if (t.testid) keys.push('testid');
  if (t.name && !t.role) keys.push('name');
  return keys;
}

function families(t: RawTarget): string[] {
  const found: string[] = [];
  if (t.ref !== undefined && t.ref !== '') found.push('ref');
  if (t.selector) found.push('selector');
  if (t.x !== undefined || t.y !== undefined) found.push('{x,y}');
  const semantic = semanticKeys(t);
  if (semantic.length === 1) found.push(semantic[0]);
  else if (semantic.length > 1) found.push(semantic.join('+'));
  return found;
}

export function pickTarget(t: RawTarget | undefined, action: ActAction, slot: 'target' | 'to'): Target | undefined {
  if (!t) return undefined;
  const found = families(t);
  if ((t.x === undefined) !== (t.y === undefined)) reject(action, `${slot} point needs both x and y.`);
  if (semanticKeys(t).length > 1) reject(action, `${slot} mixes ${semanticKeys(t).join(' and ')}. name is only a modifier of role.`);
  if (found.includes('{x,y}') && (t.frame !== undefined || t.within || t.nth !== undefined)) reject(action, `${slot} point cannot take frame, within, or nth. Those are ignored and the click hits the top document.`);
  if (found.length > 1) reject(action, `${slot} mixes ${found.join(' and ')}. ${TARGET_HELP}`);
  if (found.length === 0) {
    if (t.frame !== undefined || t.within || t.nth !== undefined) reject(action, `${slot} has modifiers but no locator.`);
    return undefined;
  }
  const mods = { ...(t.frame !== undefined && { frame: t.frame }), ...(t.within && { within: t.within }) };
  if (t.ref !== undefined && t.ref !== '') return { ref: t.ref, ...mods };
  if (t.selector) return { selector: t.selector, ...(t.nth !== undefined && { nth: t.nth }), ...mods };
  if (t.x !== undefined && t.y !== undefined) return { x: t.x, y: t.y };
  return { role: t.role, name: t.name, label: t.label, text: t.text, testid: t.testid, ...(t.nth !== undefined && { nth: t.nth }), ...mods };
}

function present(value: unknown): boolean {
  return value !== undefined;
}

export function checkActInput(input: ActToolInput): { target?: Target; to?: Target; method?: 'cdp' | 'dom' } {
  validate(actionShape, input);
  const rule = ACTION_RULES[input.action];
  if (!Object.hasOwn(ACTION_RULES, input.action)) throw new ActionError('invalid_args', `Unknown action ${input.action}`, `Choose one of: ${Object.keys(ACTION_RULES).join(', ')}`);
  const target = pickTarget(input.target, input.action, 'target');
  const to = pickTarget(input.to, input.action, 'to');
  if (rule.target === 'required' && !target) reject(input.action, `action "${input.action}" needs a target.`);
  if (rule.target === 'forbidden' && target) reject(input.action, `action "${input.action}" does not take a target.`);
  if (rule.to === 'required' && !to) reject(input.action, `action "${input.action}" needs to.`);
  if (rule.to === 'forbidden' && to) reject(input.action, `action "${input.action}" does not take to.`);
  if (rule.value === 'present' && input.value === undefined) reject(input.action, `action "${input.action}" needs value. Pass "" to clear the field; omitting it would clear it by accident.`);
  if (rule.value === 'nonempty' && !input.value) reject(input.action, `action "${input.action}" needs a non-empty value. Omitting it is not a default key.`);
  if (rule.value === 'forbidden' && present(input.value)) reject(input.action, `action "${input.action}" does not take value.`);
  if (rule.files === 'required' && !(input.files && input.files.length)) reject(input.action, `action "${input.action}" needs files.`);
  if (rule.files === 'forbidden' && input.files !== undefined) reject(input.action, `action "${input.action}" does not take files.`);
  if (!rule.scroll && (input.direction !== undefined || input.amount !== undefined)) reject(input.action, `action "${input.action}" does not take direction or amount.`);
  if (input.method !== undefined) {
    if (input.method !== 'cdp' && input.method !== 'dom') reject(input.action, 'method must be "cdp" or "dom".');
    if (input.action !== 'click') reject(input.action, `action "${input.action}" does not take method.`);
    if (input.method === 'dom' && input.target && (input.target.x !== undefined || input.target.y !== undefined)) reject(input.action, 'method "dom" needs an element, not a point.');
  }
  return { target, to, ...(input.method && { method: input.method }) };
}

/** Validate the public contract before sending a compiled expectation to the page. */
export function checkExpect(what: Expectation): void {
  validate(expectationShape, what);
  const conditions = ['text', 'notText', 'url', 'title', 'visible', 'value', 'checked', 'selected', 'enabled'] as const;
  if (!what.target && !conditions.some(key => what[key] !== undefined)) throw new ActionError('invalid_args', 'expect needs a target or a condition.', 'Use a target to wait for visibility, or text/url/title for the document.');
  if (what.target) {
    const target = pickTarget(what.target, 'click', 'target');
    if (!target || 'x' in target) throw new ActionError('invalid_args', 'expect needs an element target, not a point.', 'Use find({x,y}) to obtain an element target.');
    if (what.url !== undefined || what.title !== undefined) throw new ActionError('invalid_args', 'Use separate expectations for an element and page URL/title.');
  } else if (['visible', 'value', 'checked', 'selected', 'enabled'].some(key => what[key as keyof Expectation] !== undefined)) {
    throw new ActionError('invalid_args', 'Control conditions require target.', 'Pass the same target used by read or act.');
  }
}
