import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnBili, biliGet } from './_shared.js';

export default defineAdapter({
  description: 'Your Bilibili watch history, most recent first (requires login).',
  access: 'read',
  domain: 'bilibili.com',
  args: [
    { name: 'limit', type: 'int', default: 20, help: 'How many history items to return' },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous call (view_at seconds), to page further back' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const ps = Math.min(Math.max(1, Number(args.limit) || 20), 30);
    const at = args.cursor ? `&view_at=${encodeURIComponent(String(args.cursor))}` : '';
    const data = await biliGet(tab, `https://api.bilibili.com/x/web-interface/history/cursor?ps=${ps}${at}`);
    const rows = (data.list || []).map((v) => ({
      title: v.title, author: v.author_name, bvid: v.history?.bvid,
      viewed_at: v.view_at ? new Date(v.view_at * 1000).toISOString() : '',
      progress_s: v.progress, duration_s: v.duration,
      url: v.history?.bvid ? `https://www.bilibili.com/video/${v.history.bvid}` : undefined,
    }));
    if (!rows.length) throw errors.empty('No watch history (or not logged in)');
    const next = data.cursor?.view_at;
    return { rows, ...(next && { nextCursor: String(next) }) };
  },
});
