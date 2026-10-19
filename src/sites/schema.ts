/** One adapter argument contract drives discovery, MCP schemas, and runtime validation. */
import { z, type ZodTypeAny } from 'zod';
import { ActionError } from '../api/errors.js';
import type { Arg, ArgValue } from 'browsermcp/adapter-sdk';
export type { Arg } from 'browsermcp/adapter-sdk';

export type ArgView = Arg;

export function argSpec(args: Arg[] = []): ArgView[] {
  return args.map((a) => ({ ...a, type: a.type ?? 'string', required: a.required === true }));
}

function valueToZod(value: ArgValue, depth = 0): ZodTypeAny {
  if (depth > 8) throw new Error('adapter argument schema is too deeply nested');
  let t: ZodTypeAny;
  switch (value.type ?? 'string') {
    case 'string': t = z.string(); if (value.minLength !== undefined) t = (t as z.ZodString).min(value.minLength); if (value.maxLength !== undefined) t = (t as z.ZodString).max(value.maxLength); break;
    case 'int': t = z.number().int(); if (value.min !== undefined) t = (t as z.ZodNumber).min(value.min); if (value.max !== undefined) t = (t as z.ZodNumber).max(value.max); break;
    case 'number': t = z.number(); if (value.min !== undefined) t = (t as z.ZodNumber).min(value.min); if (value.max !== undefined) t = (t as z.ZodNumber).max(value.max); break;
    case 'boolean': t = z.boolean(); break;
    case 'array': t = z.array(valueToZod(value.items ?? { type: 'string' }, depth + 1)); if (value.min !== undefined) t = (t as z.ZodArray<ZodTypeAny>).min(value.min); if (value.max !== undefined) t = (t as z.ZodArray<ZodTypeAny>).max(value.max); break;
    case 'object': {
      const shape: Record<string, ZodTypeAny> = {};
      for (const [key, field] of Object.entries(value.properties ?? {})) {
        let fieldType = valueToZod(field, depth + 1);
        if (field.help) fieldType = fieldType.describe(field.help);
        shape[key] = field.required ? fieldType : fieldType.optional();
      }
      t = z.object(shape).strict(); break;
    }
    default: throw new Error(`unknown adapter argument type: ${String(value.type)}`);
  }
  if (value.choices?.length) {
    const literals = value.choices.map((choice) => z.literal(choice));
    t = z.union(literals as [typeof literals[number], ...Array<typeof literals[number]>]).and(t);
  }
  if (value.nullable) t = t.nullable();
  const desc = value.example !== undefined ? `example: ${JSON.stringify(value.example)}` : '';
  return desc ? t.describe(desc) : t;
}

export function argToZod(arg: Arg): ZodTypeAny {
  let t = valueToZod(arg);
  const desc = [arg.help, arg.default !== undefined ? `default: ${JSON.stringify(arg.default)}` : ''].filter(Boolean).join(' · ');
  if (desc) t = t.describe(desc);
  return arg.required ? t : t.optional();
}

export function argsToShape(args: Arg[] = [], extra: Record<string, ZodTypeAny> = {}): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {};
  for (const a of args) shape[a.name] = argToZod(a);
  for (const [k, v] of Object.entries(extra)) if (!(k in shape)) shape[k] = v;
  return shape;
}

function invalidArgs(message: string, args: Arg[]): never {
  throw new ActionError('invalid_args', message, 'Call again with the fields in details.expected. Do not guess.', { details: { expected: argSpec(args) } });
}

export function validateArgDefinitions(args: Arg[] = []): void {
  const names = new Set<string>();
  for (const arg of args) {
    if (!/^[a-z][a-z0-9_]*$/.test(arg.name) || names.has(arg.name)) throw new Error(`invalid or duplicate argument name: ${arg.name}`);
    names.add(arg.name);
    validateValueDefinition(arg, arg.name);
    const schema = valueToZod(arg);
    if (arg.default !== undefined && !schema.safeParse(arg.default).success) throw new Error(`invalid default for argument ${arg.name}`);
    if (arg.required && arg.default !== undefined) throw new Error(`argument ${arg.name} cannot be required and have a default`);
  }
}

function validateValueDefinition(value: ArgValue, location: string, depth = 0): void {
  if (depth > 8) throw new Error(`argument ${location} is too deeply nested`);
  const type = value.type ?? 'string';
  if (value.min !== undefined && value.max !== undefined && value.min > value.max) throw new Error(`argument ${location} has min > max`);
  if (value.minLength !== undefined && value.maxLength !== undefined && value.minLength > value.maxLength) throw new Error(`argument ${location} has minLength > maxLength`);
  if (value.min !== undefined || value.max !== undefined) if (!['int', 'number', 'array'].includes(type)) throw new Error(`argument ${location}: min/max require a number or array`);
  if (value.minLength !== undefined || value.maxLength !== undefined) if (type !== 'string') throw new Error(`argument ${location}: minLength/maxLength require a string`);
  if (type === 'array') {
    if (!value.items) throw new Error(`array argument ${location} needs items`);
    validateValueDefinition(value.items, `${location}[]`, depth + 1);
  } else if (value.items) throw new Error(`argument ${location}: items require an array`);
  if (type === 'object') {
    if (!value.properties) throw new Error(`object argument ${location} needs properties`);
    for (const [name, field] of Object.entries(value.properties)) {
      if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`invalid object property ${location}.${name}`);
      validateValueDefinition(field, `${location}.${name}`, depth + 1);
    }
  } else if (value.properties) throw new Error(`argument ${location}: properties require an object`);
  if (value.choices !== undefined) {
    if (!value.choices.length || !['string', 'int', 'number', 'boolean'].includes(type)) throw new Error(`argument ${location}: choices require a nonempty scalar list`);
    const withoutChoices = { ...value, choices: undefined };
    const base = valueToZod(withoutChoices, depth);
    if (value.choices.some((choice) => !base.safeParse(choice).success)) throw new Error(`argument ${location}: choices do not match the declared type or bounds`);
  }
  if (value.example !== undefined && !valueToZod(value, depth).safeParse(value.example).success) throw new Error(`argument ${location}: example does not match the declared type`);
}

/** Coerce CLI-like scalar input once, then validate the same schema exposed to MCP. */
export function coerceArgs(cmdArgs: Arg[] = [], kwargs: Record<string, unknown>): Record<string, unknown> {
  const names = new Set(cmdArgs.map((a) => a.name));
  const unknown = Object.keys(kwargs).filter((name) => !names.has(name));
  if (unknown.length) invalidArgs(`Unknown argument${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`, cmdArgs);
  const out: Record<string, unknown> = {};
  for (const def of cmdArgs) {
    let val = kwargs[def.name];
    if (val === undefined && def.default !== undefined) val = def.default;
    if (def.required && (val === undefined || val === null && !def.nullable || val === '')) invalidArgs(`Argument "${def.name}" is required. ${def.help ?? ''}`.trim(), cmdArgs);
    if (val === undefined) continue;
    if ((def.type === 'int' || def.type === 'number') && typeof val === 'string' && val.trim()) val = Number(val);
    if (def.type === 'boolean' && typeof val === 'string' && ['true', 'false', '1', '0'].includes(val.toLowerCase())) val = ['true', '1'].includes(val.toLowerCase());
    const parsed = valueToZod(def).safeParse(val);
    if (!parsed.success) {
      const message = def.type === 'boolean' ? 'must be a boolean' : def.choices?.length ? `must be one of ${def.choices.join(', ')}` : parsed.error.issues.map((i) => i.message).join('; ');
      invalidArgs(`Argument "${def.name}" ${message}`, cmdArgs);
    }
    out[def.name] = parsed.data;
  }
  return out;
}
