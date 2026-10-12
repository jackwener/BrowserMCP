import reference from '../../src/shared/chrome-reference.json';
import type { Session, SessionManager } from './sessions';

type MethodReference = { signatures: string[]; parameters?: unknown; resultFields?: Record<string, string>; callback: boolean; documentation: string };
const methods = reference.methods as Record<string, MethodReference>;
const fail = (code: string, message: string, hint?: string) => Object.assign(new Error(message), { code, hint });

/** Resolve native members without evaluating generated code or losing the receiver. */
export function chromeMember(path: string): { receiver: any; value: any } {
  if (!/^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/.test(path)) throw fail('invalid_args', 'Use a dotted Chrome member such as tabs.query');
  let receiver: any = chrome;
  const parts = path.split('.');
  for (const part of parts.slice(0, -1)) receiver = receiver?.[part];
  return { receiver, value: receiver?.[parts.at(-1)!] };
}

export async function describeChrome(member: string): Promise<unknown> {
  const { value } = chromeMember(member);
  const manifest = chrome.runtime.getManifest();
  return {
    member, available: typeof value === 'function' || Boolean(value?.addListener),
    context: 'extension service worker', declaredPermissions: manifest.permissions ?? [], grantedPermissions: await chrome.permissions.getAll(),
    browser: navigator.userAgent, source: reference.source,
    ...(methods[member] ?? { signatures: null, note: 'No local signature. Availability does not guarantee arguments or permissions; Chrome reports runtime errors.' }),
  };
}

export async function callChrome(method: string, args: unknown[], sessions: SessionManager, session: Session): Promise<unknown> {
  if (!Array.isArray(args)) throw fail('invalid_args', 'Chrome args must be an array of positional arguments');
  if (['debugger.attach', 'debugger.detach', 'debugger.sendCommand'].includes(method)) throw fail('runtime_state_conflict', 'Use tab.cdp for the runtime-owned debugger connection', 'tab.cdp.send(method, params) shares the existing attachment.');
  if (['runtime.connect', 'runtime.connectNative'].includes(method) || /\.(addListener|removeListener|hasListener)$/.test(method)) {
    throw fail('unsupported_call_shape', 'Ports and listener functions are not JSON calls; use browser.chrome.watch for notification events.');
  }
  const { receiver, value } = chromeMember(method);
  if (typeof value !== 'function') throw fail('chrome_api_unavailable', `chrome.${method} is unavailable in this extension context`);
  const editedGroup = ['tabGroups.move', 'tabGroups.update'].includes(method) && typeof args[0] === 'number' ? args[0] : undefined;
  let result: any;
  try {
    if (methods[method]?.callback) {
      result = await new Promise((resolve, reject) => {
        Reflect.apply(value, receiver, [...args, (...values: unknown[]) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(values.length > 1 ? values : values[0]);
        }]);
      });
    } else result = await Reflect.apply(value, receiver, args);
  } catch (error) { throw fail('chrome_api_error', `chrome.${method}: ${error instanceof Error ? error.message : String(error)}`); }
  // Commit lifecycle effects only after Chrome accepted the operation.
  const update = method === 'tabs.update' ? args[args.length - 1] as { muted?: boolean } | undefined : undefined;
  if (typeof update?.muted === 'boolean' && typeof result?.id === 'number') await sessions.preserveNativeMute(result.id);
  if (editedGroup !== undefined) await sessions.releaseManagedGroup(editedGroup);
  if (method === 'tabs.group' && typeof result === 'number') await sessions.releaseManagedGroup(result);
  // Attribute only resources returned by this command, never coincidentally created tabs.
  if (method === 'tabs.create' || method === 'tabs.duplicate') await sessions.adoptCreatedTab(session, result);
  if (method === 'windows.create' && result?.id !== undefined) {
    const movedId = (args[0] as { tabId?: number } | undefined)?.tabId;
    if (!Array.isArray(result.tabs)) throw fail('resource_tracking_failed', `Chrome created window ${result.id} without its tab list; inspect that window before cleanup.`);
    const tabs: chrome.tabs.Tab[] = result.tabs;
    for (const tab of tabs) if (tab.id !== movedId) await sessions.adoptCreatedTab(session, tab);
  }
  return result ?? null;
}
