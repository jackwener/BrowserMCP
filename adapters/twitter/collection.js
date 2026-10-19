import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnX, gql, resolveUserId, normalizeScreenName, extractMedia, apiError } from './_shared.js';

const QUERY_ID = 'lrMzG9qPQHpqJdP3AbM-bQ';
const FIELD_TOGGLES = {
  withPayments: true, withAuxiliaryUserLabels: true, withArticleRichContentState: true, withArticlePlainText: true,
  withArticleSummaryText: true, withArticleVoiceOver: true, withGrokAnalyze: true, withDisallowedReplyControls: true,
};
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_PAGES = 100;
const PAGE_SIZE = 100;

function unwrap(result) {
  if (!result) return null;
  if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) return result.tweet;
  return result.tweet || result;
}

function relationshipTarget(result, fallbackId, contextStatus) {
  const tweet = unwrap(result);
  const user = tweet?.core?.user_results?.result;
  const handle = normalizeScreenName(user?.legacy?.screen_name || user?.core?.screen_name || '') || null;
  const authorId = (user?.rest_id || user?.legacy?.id_str || '').trim() || null;
  const postId = (tweet?.rest_id || fallbackId || '').trim() || null;
  const hasContext = Boolean(tweet?.note_tweet?.note_tweet_results?.result?.text || tweet?.legacy?.full_text);
  const status = contextStatus === 'complete' && !hasContext ? (postId ? 'unavailable' : 'unknown') : contextStatus;
  return { post_id: postId, author_handle: handle, author_id: authorId, url: postId && handle ? `https://x.com/${handle}/status/${postId}` : null, context_status: status };
}

function extractRelationship(tweet) {
  const legacy = tweet?.legacy || {};
  const repostResult = tweet?.retweeted_status_result?.result || legacy.retweeted_status_result?.result || null;
  const repostId = legacy.retweeted_status_id_str || null;
  if (repostResult || repostId) {
    const target = relationshipTarget(repostResult, repostId, repostResult ? 'complete' : 'unknown');
    if (!repostResult || !target.post_id) throw errors.upstream('collection: repost target is unavailable');
    return { kind: 'repost', target };
  }
  const quoteResult = tweet?.quoted_status_result?.result || legacy.quoted_status_result?.result || null;
  const quoteId = legacy.quoted_status_id_str || null;
  if (legacy.is_quote_status || quoteResult || quoteId) return { kind: 'quote', target: relationshipTarget(quoteResult, quoteId, quoteResult ? 'complete' : 'unavailable') };
  const replyId = legacy.in_reply_to_status_id_str || null;
  const replyHandle = normalizeScreenName(legacy.in_reply_to_screen_name || '') || null;
  const replyAuthorId = (legacy.in_reply_to_user_id_str || '').trim() || null;
  if (replyId || replyHandle || replyAuthorId) {
    return { kind: 'reply', target: { post_id: replyId, author_handle: replyHandle, author_id: replyAuthorId, url: replyId && replyHandle ? `https://x.com/${replyHandle}/status/${replyId}` : null, context_status: replyId ? 'unavailable' : 'unknown' } };
  }
  return { kind: 'original', target: null };
}

function extractPost(result, seen) {
  const tweet = unwrap(result);
  if (!tweet?.rest_id) throw errors.upstream('collection: timeline post is missing a stable ID');
  if (seen.has(tweet.rest_id)) return null;
  seen.add(tweet.rest_id);
  const legacy = tweet.legacy || {};
  const user = tweet.core?.user_results?.result;
  const author = user?.legacy?.screen_name || user?.core?.screen_name || null;
  if (!author || !normalizeScreenName(author)) throw errors.upstream('collection: timeline post is missing an author handle');
  return {
    id: tweet.rest_id, author, name: user?.legacy?.name || user?.core?.name || '',
    text: tweet.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || '',
    likes: legacy.favorite_count || 0, retweets: legacy.retweet_count || 0, replies: legacy.reply_count || 0,
    views: Number(tweet.views?.count) || 0, is_retweet: Boolean(legacy.retweeted_status_result),
    created_at: legacy.created_at || '', url: `https://x.com/${author}/status/${tweet.rest_id}`,
    ...extractMedia(legacy), relationship: extractRelationship(tweet),
  };
}

function parsePage(data, seen) {
  const result = data?.data?.user?.result;
  if (!result || typeof result !== 'object') throw errors.upstream('collection: missing UserTweets result');
  const sets = [result.timeline_v2?.timeline?.instructions, result.timeline?.timeline?.instructions].filter(Array.isArray);
  if (!sets.length) throw errors.upstream('collection: missing UserTweets timeline instructions');
  const posts = [];
  let nextCursor = null;
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'TimelinePinEntry') return;
    if (value.tweet_results?.result) { const p = extractPost(value.tweet_results.result, seen); if (p) posts.push(p); }
    if ((value.entryType === 'TimelineTimelineCursor' || value.__typename === 'TimelineTimelineCursor') && (value.cursorType === 'Bottom' || value.cursorType === 'ShowMore') && value.value) nextCursor = value.value;
    if (Array.isArray(value)) { for (const v of value) visit(v); return; }
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  for (const s of sets) visit(s);
  return [posts, nextCursor];
}

export default defineAdapter({
  description: 'A user timeline with relationship facts (original/reply/quote/repost) and a bounded completion receipt. Pages back until the `until` timestamp is reached or the timeline is exhausted.',
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'username', type: 'string', required: true, help: 'Screen name (with or without @)' },
    { name: 'until', type: 'string', required: true, help: 'RFC3339 lower time boundary that must be reached or exhausted, e.g. 2026-07-23T00:00:00Z' },
    { name: 'limit', type: 'int', default: MAX_PAGES * PAGE_SIZE, help: 'Safety ceiling; reaching it is a typed failure' },
  ],
  async run({ tab, args }) {
    const untilRaw = String(args.until || '').trim();
    if (!RFC3339.test(untilRaw) || Number.isNaN(new Date(untilRaw).getTime())) throw errors.argument('until must be an RFC3339 timestamp', 'Example: 2026-07-23T00:00:00Z');
    const until = new Date(untilRaw);
    const handle = normalizeScreenName(String(args.username || '').trim());
    if (!handle) throw errors.argument('username must be a valid X handle');
    const limit = Math.max(1, Number(args.limit) || MAX_PAGES * PAGE_SIZE);
    await ensureOnX(tab);
    const userId = await resolveUserId(tab, handle);
    const seen = new Set();
    const seenCursors = new Set();
    const posts = [];
    let cursor;
    let oldest = null;
    const receipt = (stop, pages) => ({ completed: true, stop_reason: stop, requested_until: until.toISOString(), pages_fetched: pages, oldest_seen_at: oldest ? oldest.toISOString() : null });
    for (let page = 0; page < MAX_PAGES; page++) {
      const variables = { userId, count: PAGE_SIZE, includePromotedContent: false, withQuickPromoteEligibilityTweetFields: true, withVoice: true, ...(cursor && { cursor }) };
      let data;
      try { data = await gql(tab, QUERY_ID, 'UserTweets', variables, { fieldToggles: FIELD_TOGGLES }); }
      catch (e) { throw apiError('UserTweets', e?.data?.status || e?.status || 0); }
      const [pagePosts, nextCursor] = parsePage(data, seen);
      for (const post of pagePosts) {
        if (posts.length >= limit) throw errors.upstream('collection: limit reached; completion cannot be proven');
        const createdAt = new Date(post.created_at);
        if (Number.isNaN(createdAt.getTime())) throw errors.upstream(`collection: invalid timestamp on post ${post.id}`);
        if (!oldest || createdAt < oldest) oldest = createdAt;
        posts.push(post);
        if (createdAt <= until) return { posts, receipt: receipt('time_boundary_reached', page + 1) };
      }
      if (!nextCursor) return { posts, receipt: receipt('cursor_exhausted', page + 1) };
      if (nextCursor === cursor || seenCursors.has(nextCursor)) throw errors.upstream('collection: repeated cursor; completion cannot be proven');
      if (posts.length >= limit) throw errors.upstream('collection: limit reached; completion cannot be proven');
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw errors.upstream('collection: page guard hit; completion cannot be proven');
  },
});
