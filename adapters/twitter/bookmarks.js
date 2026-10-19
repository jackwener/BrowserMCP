import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnX, gql, walkTimeline } from './_shared.js';

const QUERY_ID = 'Fy0QMy4q_aZCpkO0PnyLYw';

export default defineAdapter({
  description: 'Your bookmarked tweets, most-recently-saved first. created_at is the tweet post time (the API has no per-bookmark save time). t.co links are expanded; see the `links` field.',
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'limit', type: 'int', default: 20, help: 'How many bookmarks to return' },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous call, to page further back' },
  ],
  async run({ tab, args }) {
    await ensureOnX(tab);
    const limit = Math.max(1, Number(args.limit) || 20);
    const seen = new Set();
    const rows = [];
    let cursor = args.cursor || undefined;
    // Page until we have `limit` rows or the timeline is exhausted.
    for (let guard = 0; rows.length < limit && guard < 20; guard++) {
      const variables = { count: Math.min(limit - rows.length + 5, 100), includePromotedContent: false, ...(cursor && { cursor }) };
      const data = await gql(tab, QUERY_ID, 'Bookmarks', variables);
      const instructions = data?.data?.bookmark_timeline_v2?.timeline?.instructions || data?.data?.bookmark_timeline?.timeline?.instructions || [];
      const { tweets, nextCursor } = walkTimeline(instructions, seen);
      for (const t of tweets) if (rows.length < limit) rows.push(t);
      cursor = nextCursor || undefined;
      if (!tweets.length || !cursor) break;
    }
    if (!rows.length) throw errors.empty('No bookmarks found');
    return { rows, ...(cursor && { nextCursor: cursor }) };
  },
});
