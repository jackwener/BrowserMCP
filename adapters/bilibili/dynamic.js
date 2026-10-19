import { defineAdapter } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnBili, biliApi } from './_shared.js';

export default defineAdapter({
  description: 'Your Bilibili following dynamic feed (关注动态), most recent first (requires login).',
  access: 'read',
  domain: 'bilibili.com',
  args: [
    { name: 'limit', type: 'int', default: 15, help: 'How many dynamics to return' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const data = await biliApi(tab, '/x/polymer/web-dynamic/v1/feed/all', {});
    const results = data?.items ?? [];
    return results.slice(0, Number(args.limit) || 15).map((item) => {
      const dyn = item.modules?.module_dynamic;
      let text = '';
      if (dyn?.desc?.text) text = dyn.desc.text;
      else if (dyn?.major?.archive?.title) text = dyn.major.archive.title;
      return {
        id: item.id_str ?? '',
        author: item.modules?.module_author?.name ?? '',
        text,
        likes: item.modules?.module_stat?.like?.count ?? 0,
        url: item.id_str ? `https://t.bilibili.com/${item.id_str}` : '',
      };
    });
  },
});
