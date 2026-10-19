import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnBili, biliGet } from './_shared.js';

export default defineAdapter({
  description: 'Popular videos on Bilibili right now.',
  access: 'read',
  domain: 'bilibili.com',
  args: [
    { name: 'limit', type: 'int', default: 20, help: 'How many videos to return (max ~50)' },
    { name: 'page', type: 'int', default: 1, help: 'Page number, to see more' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const ps = Math.min(Math.max(1, Number(args.limit) || 20), 50);
    const pn = Math.max(1, Number(args.page) || 1);
    const data = await biliGet(tab, `https://api.bilibili.com/x/web-interface/popular?ps=${ps}&pn=${pn}`);
    const rows = (data.list || []).map((v) => ({
      bvid: v.bvid, title: v.title, author: v.owner?.name, mid: v.owner?.mid,
      views: v.stat?.view ?? 0, likes: v.stat?.like ?? 0, danmaku: v.stat?.danmaku ?? 0, comments: v.stat?.reply ?? 0,
      duration_s: v.duration, published: v.pubdate ? new Date(v.pubdate * 1000).toISOString() : '',
      url: `https://www.bilibili.com/video/${v.bvid}`,
    }));
    if (!rows.length) throw errors.empty('No popular videos returned');
    return { rows, ...((data.no_more === false) && { nextCursor: String(pn + 1) }) };
  },
});
