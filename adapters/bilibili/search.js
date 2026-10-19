import { defineAdapter } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnBili, biliApiSigned, stripHtml } from './_shared.js';

export default defineAdapter({
  description: 'Search Bilibili for videos or users by keyword.',
  access: 'read',
  domain: 'bilibili.com',
  args: [
    { name: 'query', type: 'string', required: true, help: 'Search keyword' },
    { name: 'type', type: 'string', default: 'video', choices: ['video', 'user'], help: 'What to search for' },
    { name: 'page', type: 'int', default: 1, help: 'Result page number' },
    { name: 'limit', type: 'int', default: 20, help: 'How many results to return' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const searchType = args.type === 'user' ? 'bili_user' : 'video';
    const data = await biliApiSigned(tab, '/x/web-interface/wbi/search/type', {
      search_type: searchType, keyword: args.query, page: Number(args.page) || 1,
    });
    const results = data?.result ?? [];
    const rows = results.slice(0, Number(args.limit) || 20).map((item, i) => {
      if (searchType === 'bili_user') {
        return {
          rank: i + 1, name: stripHtml(item.uname ?? ''), sign: (item.usign ?? '').trim(),
          fans: item.fans ?? 0, mid: item.mid ?? '',
          url: item.mid ? `https://space.bilibili.com/${item.mid}` : '',
        };
      }
      return {
        rank: i + 1, title: stripHtml(item.title ?? ''), author: item.author ?? '',
        plays: item.play ?? 0, bvid: item.bvid ?? '',
        url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : '',
      };
    });
    return rows;
  },
});
