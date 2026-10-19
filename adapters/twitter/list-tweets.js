import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnX, gql, walkTimeline, apiError, applyTopByEngagement } from './_shared.js';

const QUERY_ID = 'RlZzktZY_9wJynoepm8ZsA';

export default defineAdapter({
  description: 'Tweets from an X list timeline, newest first. t.co links are expanded (see `links`).',
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'list_id', type: 'string', required: true, help: 'Numeric ID of an X list (from the `lists` command)' },
    { name: 'limit', type: 'int', default: 50, help: 'How many tweets to return' },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous call, to page further' },
    { name: 'top_by_engagement', type: 'int', default: 0, help: 'If >0, re-rank by weighted engagement and return the top N' },
  ],
  async run({ tab, args }) {
    const listId = String(args.list_id || '').trim();
    if (!/^\d+$/.test(listId)) throw errors.argument('list_id must be a numeric list ID', 'Get it from the `lists` command');
    await ensureOnX(tab);
    const limit = Math.max(1, Number(args.limit) || 50);
    const seen = new Set();
    const rows = [];
    let cursor = args.cursor || undefined;
    for (let guard = 0; rows.length < limit && guard < 40; guard++) {
      const variables = { listId, count: Math.min(limit - rows.length + 10, 100), ...(cursor && { cursor }) };
      let data;
      try { data = await gql(tab, QUERY_ID, 'ListLatestTweetsTimeline', variables); }
      catch (e) { if (rows.length) break; throw apiError('ListLatestTweetsTimeline', e?.data?.status || e?.status || 0, 'list may be private'); }
      const instructions = data?.data?.list?.tweets_timeline?.timeline?.instructions || [];
      const { tweets, nextCursor } = walkTimeline(instructions, seen);
      for (const t of tweets) if (rows.length < limit) rows.push(t);
      if (!tweets.length || !nextCursor || nextCursor === cursor) { cursor = nextCursor && nextCursor !== cursor ? nextCursor : undefined; break; }
      cursor = nextCursor;
    }
    if (!rows.length) throw errors.empty(`No tweets found in list ${listId}`);
    return { rows: applyTopByEngagement(rows, args.top_by_engagement), ...(cursor && { nextCursor: cursor }) };
  },
});
