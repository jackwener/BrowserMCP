import { createHash } from 'node:crypto';
import type { RuntimePage } from '../backends/page-types.js';
import type { FrameStep } from '../protocol.js';

export interface PageTool { name: string; description?: string; inputSchema?: unknown }
export interface PageToolsUpdate { status: 'ready' | 'unavailable'; frame: FrameStep[]; tools: Array<{ name: string; description?: string }>; truncated?: boolean }

/** Discovery is read-only and bounded. Full schemas are returned only on explicit lookup. */
export async function pageTools(page: RuntimePage, frame: FrameStep[] = []): Promise<PageTool[]> {
  const script = `(async () => {
    const mc = navigator.modelContext || document.modelContext;
    const source = navigator.modelContextTesting?.listTools ? navigator.modelContextTesting : mc;
    const list = source?.listTools || source?.getTools;
    if (!list) return [];
    const tools = await list.call(source);
    return (tools || []).map(t => ({name:t.name, description:t.description, inputSchema:t.inputSchema}));
  })()`;
  const value = frame.length ? await page.evaluateInFrame(script, frame, 1000) : await page.evaluate(script, {timeoutMs:1000});
  return Array.isArray(value) ? value.filter(t => t && typeof t.name === 'string') : [];
}

export async function pageToolsUpdate(page: RuntimePage, cache: Map<string, string>, key: string, frame: FrameStep[]): Promise<PageToolsUpdate | undefined> {
  try {
    const catalog = await pageTools(page, frame);
    const fingerprint = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
    const previous = cache.get(key);
    cache.set(key, fingerprint);
    if (previous === fingerprint || (previous === undefined && !catalog.length)) return;
    const tools: PageToolsUpdate['tools'] = [];
    let truncated = false;
    for (const tool of catalog) {
      const summary = {name:tool.name, ...(tool.description && {description:tool.description.slice(0,160)})};
      if (tools.length >= 12 || JSON.stringify([...tools,summary]).length > 2000) { truncated = true; continue; }
      if ((tool.description?.length ?? 0) > 160) truncated = true;
      tools.push(summary);
    }
    return {status:'ready', frame, tools, ...(truncated && {truncated})};
  } catch {
    const previous = cache.get(key);
    cache.set(key, 'unavailable');
    return previous === 'unavailable' ? undefined : {status:'unavailable', frame, tools:[]};
  }
}
