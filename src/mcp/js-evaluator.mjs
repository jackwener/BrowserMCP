/** V8's persistent REPL, accessed through Node's public in-process Inspector API. */
import { Session } from 'node:inspector';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function createEvaluator() {
  const inspector = new Session();
  inspector.connect();
  const post = (method, params = {}) => new Promise((resolve, reject) => {
    inspector.post(method, params, (error, result) => error ? reject(error) : resolve(result));
  });
  let contextId;
  const onContext = ({ params }) => { if (params.context.name === 'browsermcp-repl') contextId = params.context.id; };
  inspector.on('Runtime.executionContextCreated', onContext);
  await post('Runtime.enable');
  const context = vm.createContext({
    require: createRequire(path.join(process.cwd(), 'repl.js')),
  }, { name: 'browsermcp-repl', importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  // Keep realm-local JS intrinsics; expose the Node globals provided by this runtime.
  const intrinsics = new Set(vm.runInContext('Object.getOwnPropertyNames(globalThis)', context));
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (name === 'global' || intrinsics.has(name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    if (descriptor.get) descriptor.get = descriptor.get.bind(globalThis);
    if (descriptor.set) descriptor.set = descriptor.set.bind(globalThis);
    Object.defineProperty(context, name, descriptor);
  }
  context.global = context;
  inspector.off('Runtime.executionContextCreated', onContext);
  if (contextId === undefined) throw new Error('Could not create the JavaScript execution context');

  async function unwrap(remote) {
    if (!remote.objectId && !remote.unserializableValue) return remote.value;
    // Transfer the actual reference, preserving API proxies, functions and typed arrays.
    const key = `__browsermcp_result_${randomUUID().replaceAll('-', '')}`;
    try {
      await post('Runtime.callFunctionOn', {
        executionContextId: contextId,
        functionDeclaration: `function(value) { this[${JSON.stringify(key)}] = value; }`,
        arguments: [remote.objectId ? { objectId: remote.objectId } : { unserializableValue: remote.unserializableValue }],
      });
      return context[key];
    } finally { delete context[key]; }
  }

  return {
    context,
    async evaluate(code, id) {
      const objectGroup = `cell-${id}`;
      try {
        const result = await post('Runtime.evaluate', {
          expression: code, contextId, objectGroup, replMode: true, awaitPromise: true,
        });
        if (result.exceptionDetails) {
          return { ok: false, error: result.exceptionDetails.exception
            ? await unwrap(result.exceptionDetails.exception)
            : new Error(result.exceptionDetails.text) };
        }
        return { ok: true, value: await unwrap(result.result) };
      } finally { await post('Runtime.releaseObjectGroup', { objectGroup }); }
    },
  };
}
