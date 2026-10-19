import { defineAdapter } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnBili, biliApiSigned, resolveUid } from './_shared.js';

export default defineAdapter({
  description: 'List a Bilibili user\'s uploaded videos (投稿). Accepts a uid or username.',
  access: 'read',
  domain: 'bilibili.com',
  args: [
    { name: 'uid', type: 'string', required: true, help: 'User uid or username' },
    { name: 'limit', type: 'int', default: 20, help: 'How many videos to return' },
    { name: 'order', type: 'string', default: 'pubdate', choices: ['pubdate', 'click', 'stow'], help: 'Sort by publish date, plays, or favorites' },
    { name: 'page', type: 'int', default: 1, help: 'Page number' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const uid = await resolveUid(tab, String(args.uid));
    const limit = Number(args.limit) || 20;
    const data = await biliApiSigned(tab, '/x/space/wbi/arc/search', {
      mid: uid, pn: Number(args.page) || 1, ps: Math.min(limit, 50), order: args.order || 'pubdate',
    });
    const vlist = data?.list?.vlist ?? [];
    return vlist.slice(0, limit).map((item, i) => ({
      rank: i + 1,
      title: item.title ?? '',
      plays: item.play ?? 0,
      likes: item.like ?? 0,
      published: item.created ? new Date(item.created * 1000).toISOString().slice(0, 10) : '',
      bvid: item.bvid ?? '',
      url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : '',
    }));
  },
});
