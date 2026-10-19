import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnX, gql, walkTimeline, resolveUserId, resolveLoggedInUser, normalizeScreenName, apiError, applyTopByEngagement } from './_shared.js';

const QUERY_ID = 'CDWHmpZeSdIJ3HGeRbNm0w';

export default defineAdapter({
  description: "A user's liked tweets, newest first (defaults to the logged-in user). Note: likes are private by default on X — only the owner can read their own. t.co links are expanded (see `links`).",
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'username', type: 'string', help: 'Screen name (with or without @). Omit for the logged-in user.' },
    { name: 'limit', type: 'int', default: 20, help: 'How many liked tweets to return' },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous call, to page further' },
    { name: 'top_by_engagement', type: 'int', default: 0, help: 'If >0, re-rank by weighted engagement and return the top N' },
  ],
  async run({ tab, args }) {
    await ensureOnX(tab);
    const raw = String(args.username || '').trim();
    let username = raw ? normalizeScreenName(raw) : '';
    if (raw && !username) throw errors.argument('username must be a valid X handle', 'Example: { username: "jack" }');
    if (!username) username = await resolveLoggedInUser(tab);
    const userId = await resolveUserId(tab, username);
    const limit = Math.max(1, Number(args.limit) || 20);
    const seen = new Set();
    const rows = [];
    let cursor = args.cursor || undefined;
    for (let guard = 0; rows.length < limit && guard < 20; guard++) {
      const variables = { userId, count: Math.min(limit - rows.length + 10, 100), includePromotedContent: false, withClientEventToken: false, withBirdwatchNotes: false, withVoice: true, ...(cursor && { cursor }) };
      let data;
      try { data = await gql(tab, QUERY_ID, 'Likes', variables); }
      catch (e) { if (rows.length) break; throw apiError('Likes', e?.data?.status || e?.status || 0); }
      const instructions = data?.data?.user?.result?.timeline_v2?.timeline?.instructions || data?.data?.user?.result?.timeline?.timeline?.instructions || [];
      const { tweets, nextCursor } = walkTimeline(instructions, seen);
      for (const t of tweets) if (rows.length < limit) rows.push(t);
      cursor = nextCursor || undefined;
      if (!tweets.length || !cursor) break;
    }
    if (!rows.length) throw errors.empty(`No likes found for @${username} (likes are private by default on X)`);
    return { rows: applyTopByEngagement(rows, args.top_by_engagement), ...(cursor && { nextCursor: cursor }) };
  },
});
