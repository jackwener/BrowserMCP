import { defineAdapter } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnBili, biliApi } from './_shared.js';

export default defineAdapter({
  description: 'Bilibili all-category ranking board (排行榜).',
  access: 'read',
  domain: 'bilibili.com',
  args: [
    { name: 'limit', type: 'int', default: 20, help: 'How many videos to return' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const data = await biliApi(tab, '/x/web-interface/ranking/v2', { rid: 0, type: 'all' });
    const results = data?.list ?? [];
    return results.slice(0, Number(args.limit) || 20).map((item, i) => ({
      rank: i + 1,
      title: item.title ?? '',
      author: item.owner?.name ?? '',
      views: item.stat?.view ?? 0,
      bvid: item.bvid ?? '',
      url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : '',
    }));
  },
});
