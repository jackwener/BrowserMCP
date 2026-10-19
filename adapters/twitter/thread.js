import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnX, gql, extractTweet, tweetIdFrom, apiError, applyTopByEngagement } from './_shared.js';

const QUERY_ID = 'nBS-WpgA6ZG0CyNHD517JQ';
const FIELD_TOGGLES = { withArticleRichContentState: true, withArticlePlainText: false };

function parseDetail(data, seen) {
  const tweets = [];
  let nextCursor = null;
  const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions || data?.data?.tweetResult?.result?.timeline?.instructions || [];
  for (const inst of instructions) {
    for (const entry of inst.entries || []) {
      const c = entry.content || {};
      if (c.entryType === 'TimelineTimelineCursor' || c.__typename === 'TimelineTimelineCursor') { if (c.cursorType === 'Bottom' || c.cursorType === 'ShowMore') nextCursor = c.value; continue; }
      if (String(entry.entryId || '').startsWith('cursor-bottom-') || String(entry.entryId || '').startsWith('cursor-showMore-')) { nextCursor = c.itemContent?.value || c.value || nextCursor; continue; }
      const r = c.itemContent?.tweet_results?.result;
      if (r) { const t = extractTweet(r, seen); if (t) tweets.push(t); }
      for (const item of c.items || []) {
        const nr = item.item?.itemContent?.tweet_results?.result;
        if (nr) { const t = extractTweet(nr, seen); if (t) tweets.push(t); }
      }
    }
  }
  return { tweets, nextCursor };
}

export default defineAdapter({
  description: 'A tweet thread: the original tweet plus its replies. t.co links are expanded (see `links`).',
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'tweet_id', type: 'string', required: true, help: 'Tweet numeric ID or a full status URL' },
    { name: 'limit', type: 'int', default: 50, help: 'How many tweets (original + replies) to return' },
    { name: 'top_by_engagement', type: 'int', default: 0, help: 'If >0, re-rank by weighted engagement and return the top N' },
  ],
  async run({ tab, args }) {
    const tweetId = tweetIdFrom(args.tweet_id);
    await ensureOnX(tab);
    const limit = Math.max(1, Number(args.limit) || 50);
    const seen = new Set();
    const rows = [];
    let cursor;
    for (let i = 0; i < 5 && rows.length < limit; i++) {
      const variables = { focalTweetId: tweetId, referrer: 'tweet', with_rux_injections: false, includePromotedContent: false, rankingMode: 'Recency', withCommunity: true, withQuickPromoteEligibilityTweetFields: true, withBirdwatchNotes: true, withVoice: true, ...(cursor && { cursor }) };
      let data;
      try { data = await gql(tab, QUERY_ID, 'TweetDetail', variables, { fieldToggles: FIELD_TOGGLES }); }
      catch (e) { if (rows.length) break; throw apiError('TweetDetail', e?.data?.status || e?.status || 0); }
      const { tweets, nextCursor } = parseDetail(data, seen);
      for (const t of tweets) if (rows.length < limit) rows.push(t);
      if (!nextCursor || nextCursor === cursor) { cursor = undefined; break; }
      cursor = nextCursor;
    }
    if (!rows.length) throw errors.empty(`No thread found for tweet ${tweetId}`);
    return { rows: applyTopByEngagement(rows, args.top_by_engagement), ...(cursor && { nextCursor: cursor }) };
  },
});
