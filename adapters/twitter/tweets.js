import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnX, gql, walkTimeline, resolveUserId, resolveLoggedInUser, normalizeScreenName, apiError, applyTopByEngagement } from './_shared.js';

const QUERY_ID = 'lrMzG9qPQHpqJdP3AbM-bQ';
const FIELD_TOGGLES = {
  withPayments: true, withAuxiliaryUserLabels: true, withArticleRichContentState: true, withArticlePlainText: true,
  withArticleSummaryText: true, withArticleVoiceOver: true, withGrokAnalyze: true, withDisallowedReplyControls: true,
};

export default defineAdapter({
  description: "A user's recent tweets, newest first, excluding pinned (defaults to the logged-in user). t.co links are expanded (see `links`).",
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'username', type: 'string', help: 'Screen name (with or without @). Omit for the logged-in user.' },
    { name: 'limit', type: 'int', default: 20, help: 'How many tweets to return' },
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
    for (let guard = 0; rows.length < limit && guard < 40; guard++) {
      const variables = { userId, count: Math.min(limit - rows.length + 10, 100), includePromotedContent: false, withQuickPromoteEligibilityTweetFields: true, withVoice: true, ...(cursor && { cursor }) };
      let data;
      try { data = await gql(tab, QUERY_ID, 'UserTweets', variables, { fieldToggles: FIELD_TOGGLES }); }
      catch (e) { if (rows.length) break; throw apiError('UserTweets', e?.data?.status || e?.status || 0); }
      const result = data?.data?.user?.result || {};
      const instructions = [result.timeline_v2?.timeline?.instructions, result.timeline?.timeline?.instructions].filter(Array.isArray).flat();
      const { tweets, nextCursor } = walkTimeline(instructions, seen);
      for (const t of tweets) if (rows.length < limit) rows.push(t);
      if (!nextCursor || nextCursor === cursor) { cursor = undefined; break; }
      cursor = nextCursor;
    }
    if (!rows.length) throw errors.empty(`@${username} has no recent tweets (account may be private or suspended)`);
    return { rows: applyTopByEngagement(rows, args.top_by_engagement), ...(cursor && { nextCursor: cursor }) };
  },
});
