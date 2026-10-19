import { defineAdapter } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnBili, biliApiSigned, getSelfUid } from './_shared.js';

export default defineAdapter({
  // Read-only: lists the contents of a favorites folder (does not add/remove favorites).
  description: 'List videos in one of your Bilibili favorites folders (defaults to the first folder; requires login).',
  access: 'read',
  domain: 'bilibili.com',
  args: [
    { name: 'fid', type: 'int', help: 'Favorites folder id (media_id); defaults to your first folder' },
    { name: 'limit', type: 'int', default: 20, help: 'How many items to return' },
    { name: 'page', type: 'int', default: 1, help: 'Page number' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const pageNum = Number(args.page) || 1;
    const limit = Number(args.limit) || 20;
    let fid = args.fid ? Number(args.fid) : null;
    if (!fid) {
      const uid = await getSelfUid(tab);
      const foldersData = await biliApiSigned(tab, '/x/v3/fav/folder/created/list-all', { up_mid: uid });
      const folders = foldersData?.list ?? [];
      if (!folders.length) return [];
      fid = folders[0].id;
    }
    const data = await biliApiSigned(tab, '/x/v3/fav/resource/list', {
      media_id: fid, pn: pageNum, ps: Math.min(limit, 40),
    });
    const medias = data?.medias ?? [];
    return medias.slice(0, limit).map((item, i) => ({
      rank: i + 1,
      title: item.title ?? '',
      author: item.upper?.name ?? '',
      plays: item.cnt_info?.play ?? 0,
      bvid: item.bvid ?? '',
      url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : '',
    }));
  },
});
