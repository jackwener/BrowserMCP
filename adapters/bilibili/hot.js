import { defineAdapter } from 'browsermcp/adapter-sdk';
import { ensureOnBili, biliApi } from './_shared.js';

export default defineAdapter({
  description: 'Trending videos on Bilibili right now (热门).',
  access: 'read',
  domain: 'bilibili.com',
  args: [
    { name: 'limit', type: 'int', default: 20, help: 'How many videos to return' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const limit = Math.min(Math.max(1, Number(args.limit) || 20), 50);
    const data = await biliApi(tab, '/x/web-interface/popular', { ps: limit, pn: 1 });
    return (data?.list ?? []).slice(0, limit).map((item, i) => ({
      rank: i + 1,
      title: item.title ?? '',
      author: item.owner?.name ?? '',
      views: item.stat?.view ?? 0,
      danmaku: item.stat?.danmaku ?? 0,
      bvid: item.bvid ?? '',
      url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : '',
    }));
  },
});
