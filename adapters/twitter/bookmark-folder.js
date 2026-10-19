import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnX, gql, walkTimeline, apiError, applyTopByEngagement } from './_shared.js';

const QUERY_ID = '13H7EUATwethsj_jZ6QQAQ';
const FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export default defineAdapter({
  description: 'Tweets inside one X bookmark folder. Get the folder id from the `bookmark-folders` command. t.co links are expanded (see `links`).',
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'folder_id', type: 'string', required: true, help: 'Folder id from the `bookmark-folders` command' },
    { name: 'limit', type: 'int', default: 20, help: 'How many bookmarks to return' },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous call, to page further' },
    { name: 'top_by_engagement', type: 'int', default: 0, help: 'If >0, re-rank by weighted engagement and return the top N' },
  ],
  async run({ tab, args }) {
    const folderId = String(args.folder_id || '').trim();
    if (!FOLDER_ID_PATTERN.test(folderId)) throw errors.argument('folder_id is invalid', 'Get it from the `bookmark-folders` command');
    await ensureOnX(tab);
    const limit = Math.max(1, Number(args.limit) || 20);
    const seen = new Set();
    const rows = [];
    let cursor = args.cursor || undefined;
    for (let guard = 0; rows.length < limit && guard < 40; guard++) {
      const variables = { bookmark_collection_id: folderId, count: Math.min(100, limit - rows.length + 10), includePromotedContent: false, ...(cursor && { cursor }) };
      let data;
      try { data = await gql(tab, QUERY_ID, 'BookmarkFolderTimeline', variables); }
      catch (e) { if (rows.length) break; throw apiError('BookmarkFolderTimeline', e?.data?.status || e?.status || 0, `folder=${folderId}`); }
      const instructions = data?.data?.bookmark_collection_timeline?.timeline?.instructions || data?.data?.bookmark_timeline_v2?.timeline?.instructions || data?.data?.bookmark_timeline?.timeline?.instructions || [];
      const { tweets, nextCursor } = walkTimeline(instructions, seen);
      for (const t of tweets) if (rows.length < limit) rows.push(t);
      if (!nextCursor || nextCursor === cursor) { cursor = undefined; break; }
      cursor = nextCursor;
    }
    if (!rows.length) throw errors.empty(`No bookmarks found in folder ${folderId}`);
    return { rows: applyTopByEngagement(rows, args.top_by_engagement), ...(cursor && { nextCursor: cursor }) };
  },
});
