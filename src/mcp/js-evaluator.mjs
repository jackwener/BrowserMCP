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
          const details = result.exceptionDetails;
          const error = details.exception ? await unwrap(details.exception) : new Error(details.text);
          if (error?.name === 'SyntaxError' && Number.isInteger(details.lineNumber)) locateSyntaxError(error, code, details.lineNumber, details.columnNumber ?? 0);
          return { ok: false, error };
        }
        return { ok: true, value: await unwrap(result.result) };
      } finally { await post('Runtime.releaseObjectGroup', { objectGroup }); }
    },
  };
}

/** Point a syntax error at the cell's own line, with two lines of context on each side. */
function locateSyntaxError(error, code, line, column) {
  const lines = code.split(/\r?\n/);
  if (line < 0 || line >= lines.length) return;
  const first = Math.max(0, line - 2), last = Math.min(lines.length - 1, line + 2);
  const width = String(last + 1).length;
  const excerpt = [];
  for (let i = first; i <= last; i++) {
    excerpt.push(`${String(i + 1).padStart(width)} | ${lines[i]}`);
    if (i === line) excerpt.push(`${' '.repeat(width)} | ${' '.repeat(Math.max(0, column))}^`);
  }
  try { error.message = `${error.message} (line ${line + 1}, column ${column + 1})\n${excerpt.join('\n')}`; } catch { /* frozen error */ }
}
