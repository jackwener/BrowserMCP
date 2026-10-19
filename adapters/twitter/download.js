import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnX, gql, resolveUserId, normalizeScreenName, extractMedia, parseTweetUrl, apiError } from './_shared.js';

const QUERY_ID = '9EovraBTXJYGSEQXZqlLmQ';
const FIELD_TOGGLES = {
  withPayments: true, withAuxiliaryUserLabels: true, withArticleRichContentState: true, withArticlePlainText: true,
  withArticleSummaryText: true, withArticleVoiceOver: true, withGrokAnalyze: true, withDisallowedReplyControls: true,
};

const classify = (url) => (!url ? 'unknown' : /video\.twimg\.com|\.mp4(\?|$)|\.m3u8(\?|$)/.test(url) ? 'video' : 'image');

function collect(data, seen, items) {
  const result = data?.data?.user?.result;
  const instructions = [result?.timeline_v2?.timeline?.instructions, result?.timeline?.timeline?.instructions].filter(Array.isArray).flat();
  let nextCursor = null;
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'TimelinePinEntry') return;
    if (value.tweet_results?.result) {
      const raw = value.tweet_results.result;
      const tw = raw.__typename === 'TweetWithVisibilityResults' && raw.tweet ? raw.tweet : (raw.tweet || raw);
      const id = tw.rest_id ? String(tw.rest_id) : '';
      if (id && !seen.has(id)) {
        seen.add(id);
        for (const url of extractMedia(tw.legacy || {}).media_urls) items.push({ tweet_id: id, url, type: classify(url) });
      }
    }
    if ((value.entryType === 'TimelineTimelineCursor' || value.__typename === 'TimelineTimelineCursor') && (value.cursorType === 'Bottom' || value.cursorType === 'ShowMore') && value.value) nextCursor = value.value;
    if (Array.isArray(value)) { for (const v of value) visit(v); return; }
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  visit(instructions);
  return nextCursor;
}

export default defineAdapter({
  description: 'Return media URLs (images and videos) from X. Pass username to list a profile\'s media via the UserMedia timeline, or tweet_url for a single tweet. Returns the media URLs as data (does not download files).',
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'username', type: 'string', help: 'Screen name (with or without @) to scan profile media. Provide this OR tweet_url.' },
    { name: 'tweet_url', type: 'string', help: 'A single tweet URL to pull media from. Provide this OR username.' },
    { name: 'limit', type: 'int', default: 10, help: 'Max media items when scanning a profile (1-1000)' },
  ],
  async run({ tab, args }) {
    await ensureOnX(tab);
    const username = String(args.username || '').trim();
    const tweetUrl = String(args.tweet_url || '').trim();
    if (!username && !tweetUrl) throw errors.argument('Provide either username or tweet_url');
    if (username && tweetUrl) throw errors.argument('Provide either username or tweet_url, not both');

    if (tweetUrl) {
      const target = parseTweetUrl(tweetUrl);
      await tab.goto(target.url, { waitUntil: 'load', settleMs: 3000 });
      const raw = await tab.evaluate(`(() => {
        const out = [];
        document.querySelectorAll('img[src*="pbs.twimg.com/media"]').forEach(img => { let s = img.src || ''; s = s.replace(/&name=\\w+$/, '&name=large'); if (!s.includes('&name=')) s += '&name=large'; out.push({ type: 'image', url: s }); });
        document.querySelectorAll('video').forEach(v => { if (v.src) out.push({ type: 'video', url: v.src }); });
        return out;
      })()`);
      const seen = new Set();
      const rows = (Array.isArray(raw) ? raw : []).filter((m) => m.url && !seen.has(m.url) && seen.add(m.url)).map((m) => ({ tweet_id: target.id, url: m.url, type: m.type }));
      if (!rows.length) throw errors.empty('No media found in the tweet');
      return rows;
    }

    const handle = normalizeScreenName(username);
    if (!handle) throw errors.argument('username must be a valid X handle');
    const limit = Math.min(1000, Math.max(1, Number(args.limit) || 10));
    const userId = await resolveUserId(tab, handle);
    const seen = new Set();
    const items = [];
    let cursor;
    for (let guard = 0; items.length < limit && guard < 100; guard++) {
      const count = Math.min(100, (limit - items.length) + 10);
      const variables = { userId, count, includePromotedContent: false, withClientEventToken: false, withBirdwatchNotes: false, withVoice: true, ...(cursor && { cursor }) };
      let data;
      try { data = await gql(tab, QUERY_ID, 'UserMedia', variables, { fieldToggles: FIELD_TOGGLES }); }
      catch (e) { if (items.length) break; throw apiError('UserMedia', e?.data?.status || e?.status || 0); }
      const nextCursor = collect(data, seen, items);
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    if (!items.length) throw errors.empty(`@${handle} has no media`);
    return items.slice(0, limit);
  },
});
