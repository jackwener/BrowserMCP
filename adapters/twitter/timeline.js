import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnX, gql, extractTweet, apiError, applyTopByEngagement } from './_shared.js';

// for-you uses GET HomeTimeline; following uses POST HomeLatestTimeline.
const ENDPOINTS = {
  'for-you': { name: 'HomeTimeline', method: 'GET', queryId: 'c-CzHF1LboFilMpsx4ZCrQ' },
  following: { name: 'HomeLatestTimeline', method: 'POST', queryId: 'BKB7oi212Fi7kQtCBGE4zA' },
};

function parseHome(data, seen) {
  const tweets = [];
  let nextCursor = null;
  const instructions = data?.data?.home?.home_timeline_urt?.instructions || [];
  for (const inst of instructions) {
    for (const entry of inst.entries || []) {
      const c = entry.content || {};
      if (c.entryType === 'TimelineTimelineCursor' || c.__typename === 'TimelineTimelineCursor') { if (c.cursorType === 'Bottom') nextCursor = c.value; continue; }
      if (String(entry.entryId || '').startsWith('cursor-bottom-')) { nextCursor = c.value || nextCursor; continue; }
      const r = c.itemContent?.tweet_results?.result;
      if (r) { if (c.itemContent?.promotedMetadata) continue; const t = extractTweet(r, seen); if (t) tweets.push(t); continue; }
      for (const item of c.items || []) {
        if (item.item?.itemContent?.promotedMetadata) continue;
        const nr = item.item?.itemContent?.tweet_results?.result;
        if (nr) { const t = extractTweet(nr, seen); if (t) tweets.push(t); }
      }
    }
  }
  return { tweets, nextCursor };
}

export default defineAdapter({
  description: "The logged-in user's home timeline. type=for-you is the algorithmic feed (default); type=following is the chronological feed of accounts you follow. t.co links are expanded (see `links`).",
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'type', type: 'string', default: 'for-you', choices: ['for-you', 'following'], help: 'Which feed: for-you (algorithmic) or following (chronological)' },
    { name: 'limit', type: 'int', default: 20, help: 'How many tweets to return' },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous call, to page further' },
    { name: 'top_by_engagement', type: 'int', default: 0, help: 'If >0, re-rank by weighted engagement and return the top N' },
  ],
  async run({ tab, args }) {
    await ensureOnX(tab);
    const type = args.type === 'following' ? 'following' : 'for-you';
    const { name, method, queryId } = ENDPOINTS[type];
    const limit = Math.max(1, Number(args.limit) || 20);
    const seen = new Set();
    const rows = [];
    let cursor = args.cursor || undefined;
    for (let guard = 0; rows.length < limit && guard < 40; guard++) {
      const variables = { count: Math.min(40, limit - rows.length + 5), includePromotedContent: false, latestControlAvailable: true, requestContext: 'launch', ...(type === 'for-you' ? { withCommunity: true } : { seenTweetIds: [] }), ...(cursor && { cursor }) };
      let data;
      try { data = await gql(tab, queryId, name, variables, { method }); }
      catch (e) { if (rows.length) break; throw apiError(name, e?.data?.status || e?.status || 0); }
      const { tweets, nextCursor } = parseHome(data, seen);
      for (const t of tweets) if (rows.length < limit) rows.push(t);
      if (!nextCursor || nextCursor === cursor) { cursor = undefined; break; }
      cursor = nextCursor;
    }
    if (!rows.length) throw errors.empty('No tweets found in the home timeline');
    return { rows: applyTopByEngagement(rows, args.top_by_engagement), ...(cursor && { nextCursor: cursor }) };
  },
});
