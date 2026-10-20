/** Persistent candidate adapters. A candidate never appears in site search or MCP tool lists until activated. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ensureUserSource, renderAdapterModule, validateDefinition, type ToolDefinition } from './define.js';
import type { CommandRunResult, CommandRunError } from './executor.js';
import { argSpec, type Arg } from './schema.js';
import { adapterCommandFromDescriptor, type AdapterCommand } from './loader.js';
import { ActionError } from '../api/errors.js';

export interface DraftExpectation { path?: string; equals?: unknown; minRows?: number }
export function createDraftStore(userAdaptersDir: string) {
  interface DraftRecord {
    id: string; site: string; name: string; createdAt: string; baselineFile: string | null; baseline: string | null;
    verified: boolean; verifiedAt?: string; verifiedDigest?: string; sampleArgs?: Record<string, unknown>; expectation?: DraftExpectation;
  }
  const DRAFT_DIR = path.join(path.dirname(userAdaptersDir), 'drafts');
  const inFlight = new Set<string>();
  const draftPath = (id: string, ext: 'json' | 'js'): string => {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ActionError('unknown_draft', 'Invalid draft id.');
    return path.join(DRAFT_DIR, `${id}.${ext}`);
  };
  const digest = (file: string): string | null => fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
  const targetPath = (site: string, name: string): string => path.join(userAdaptersDir, site, `${name}.js`);

  function readRecord(id: string): DraftRecord {
    try { return JSON.parse(fs.readFileSync(draftPath(id, 'json'), 'utf8')) as DraftRecord; }
    catch { throw new ActionError('unknown_draft', `No adapter draft ${id}.`, 'Create one with tools.define.'); }
  }
  function writeRecord(record: DraftRecord): void { fs.writeFileSync(draftPath(record.id, 'json'), JSON.stringify(record, null, 2)); }

  async function createDraft(def: ToolDefinition, activeFile?: string): Promise<{ draftId: string; site: string; name: string; args: Arg[] }> {
    validateDefinition(def);
    ensureUserSource(userAdaptersDir);
    fs.mkdirSync(DRAFT_DIR, { recursive: true });
    const id = randomUUID();
    const file = draftPath(id, 'js');
    try {
      fs.writeFileSync(file, renderAdapterModule(def));
      await import(`${pathToFileURL(file).href}?draft=${id}`);
      writeRecord({ id, site: def.site, name: def.name, createdAt: new Date().toISOString(), baselineFile: activeFile ?? null, baseline: activeFile ? digest(activeFile) : null, verified: false });
      return { draftId: id, site: def.site, name: def.name, args: argSpec(def.args) };
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err;
    }
  }

  async function loadDraftCommand(id: string): Promise<AdapterCommand> {
    const record = readRecord(id);
    const file = draftPath(id, 'js');
    const descriptor = (await import(`${pathToFileURL(file).href}?t=${digest(file)}`) as { default: Record<string, unknown> }).default;
    if (!descriptor || typeof descriptor.run !== 'function') throw new ActionError('invalid_definition', 'Draft does not export an adapter run function.');
    return adapterCommandFromDescriptor(record.site, record.name, 'user', descriptor);
  }

  function pathValue(value: unknown, expression: string): { found: boolean; value: unknown } {
    let current = value;
    for (const key of expression.split('.').filter(Boolean)) {
      if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return { found: false, value: undefined };
      current = (current as Record<string, unknown>)[key];
    }
    return { found: true, value: current };
  }

  function checkDraftResult(result: CommandRunResult | CommandRunError, expect: DraftExpectation): { passed: boolean; checks: Array<{ check: string; passed: boolean; actual?: unknown }> } {
    const checks: Array<{ check: string; passed: boolean; actual?: unknown }> = [];
    if (!result.ok) return { passed: false, checks: [{ check: 'adapter execution', passed: false, actual: result.error }] };
    if (expect.minRows !== undefined) checks.push({ check: `rows.length >= ${expect.minRows}`, passed: Array.isArray(result.rows) && result.rows.length >= expect.minRows, actual: result.rows?.length });
    if (expect.path !== undefined) {
      const found = pathValue(result, expect.path);
      const equal = !Object.hasOwn(expect, 'equals') || JSON.stringify(found.value) === JSON.stringify(expect.equals);
      checks.push({ check: Object.hasOwn(expect, 'equals') ? `${expect.path} equals expected value` : `${expect.path} exists`, passed: found.found && found.value !== undefined && equal, actual: found.value });
    }
    if (!checks.length) throw new ActionError('invalid_args', 'Verification needs minRows or path (with optional equals).', 'Choose an assertion about the real result before activating.');
    return { passed: checks.every((c) => c.passed), checks };
  }

  async function tryDraft(run: (cmd: AdapterCommand, args: Record<string, unknown>) => Promise<CommandRunResult | CommandRunError>, id: string, args: Record<string, unknown>, expect: DraftExpectation): Promise<{ result: CommandRunResult | CommandRunError; verification: ReturnType<typeof checkDraftResult> }> {
    if (expect.minRows === undefined && !expect.path?.trim()) throw new ActionError('invalid_args', 'Verification needs minRows or path.', 'Choose an assertion about the real result before running the draft.');
    if (expect.minRows !== undefined && (!Number.isInteger(expect.minRows) || expect.minRows < 1)) throw new ActionError('invalid_args', 'minRows must be at least 1.', 'Assert a returned row, or use path and equals to verify an empty result.');
    if (expect.path && !/^(rows|value)(\.|$)/.test(expect.path)) throw new ActionError('invalid_args', 'Verification path must point into rows or value.', 'Assert the adapter output, not the runtime envelope.');
    if (Object.hasOwn(expect, 'equals') && !expect.path?.trim()) throw new ActionError('invalid_args', 'equals needs path.', 'Add the dot path to compare.');
    const record = readRecord(id);
    if (inFlight.has(id)) throw new ActionError('draft_in_use', 'This draft is already being tried.', 'Wait for the current trial to finish.');
    inFlight.add(id);
    try {
      const cmd = await loadDraftCommand(id);
      const result = await run(cmd, args);
      const verification = checkDraftResult(result, expect);
      record.verified = verification.passed;
      if (verification.passed) { record.verifiedAt = new Date().toISOString(); record.verifiedDigest = digest(draftPath(id, 'js')) ?? undefined; record.sampleArgs = args; record.expectation = expect; }
      writeRecord(record);
      return { result, verification };
    } finally { inFlight.delete(id); }
  }

  function activateDraft(id: string, sourceFile: (site: string, name: string) => string | undefined): { site: string; name: string; file: string; verifiedAt: string } {
    const record = readRecord(id);
    if (inFlight.has(id)) throw new ActionError('draft_in_use', 'This draft is still being tried.', 'Wait for the trial to finish before activation.');
    const activeFile = sourceFile(record.site, record.name);
    if (!record.verified || !record.verifiedAt) throw new ActionError('draft_not_verified', 'This draft has not passed a real trial with an output assertion.', 'Run tools.try with sample args and expect first.');
    if (digest(draftPath(id, 'js')) !== record.verifiedDigest) throw new ActionError('draft_changed', 'This draft changed after its verified trial.', 'Run tools.try again before activating.');
    const target = targetPath(record.site, record.name);
    if ((activeFile ?? null) !== record.baselineFile || (activeFile ? digest(activeFile) : null) !== record.baseline || (target !== activeFile && digest(target) !== null)) throw new ActionError('draft_conflict', 'The active adapter changed after this draft was created.', 'Create a new draft from the latest definition.');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(draftPath(id, 'js'), target);
    fs.rmSync(draftPath(id, 'json'), { force: true });
    return { site: record.site, name: record.name, file: target, verifiedAt: record.verifiedAt };
  }

  function discardDraft(id: string): { draftId: string; discarded: true } {
    readRecord(id);
    if (inFlight.has(id)) throw new ActionError('draft_in_use', 'This draft is still being tried.', 'Wait for the trial to finish before discarding it.');
    fs.rmSync(draftPath(id, 'js'), { force: true });
    fs.rmSync(draftPath(id, 'json'), { force: true });
    return { draftId: id, discarded: true };
  }

  return { createDraft, tryDraft, activateDraft, discardDraft };
}
export type DraftStore = ReturnType<typeof createDraftStore>;
