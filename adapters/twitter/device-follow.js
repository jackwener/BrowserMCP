import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnX, authHeaders, apiError, applyTopByEngagement } from './_shared.js';

const PATH = '/i/api/2/notifications/device_follow.json';
const MAX_LIMIT = 200;

function buildUrl(count) {
  const p = new URLSearchParams({
    include_profile_interstitial_type: '1', include_blocking: '1', include_blocked_by: '1', include_followed_by: '1',
    include_want_retweets: '1', include_mute_edge: '1', include_can_dm: '1', include_can_media_tag: '1',
    include_ext_has_nft_avatar: '1', include_ext_is_blue_verified: '1', include_ext_verified_type: '1', skip_status: '1',
    cards_platform: 'Web-12', include_cards: '1', include_ext_alt_text: 'true', include_quote_count: 'true',
    include_reply_count: '1', tweet_mode: 'extended', include_ext_views: 'true', count: String(count),
  });
  return `${PATH}?${p.toString()}`;
}

function parse(payload, seen) {
  const tweets = payload?.globalObjects?.tweets || {};
  const users = payload?.globalObjects?.users || {};
  const rows = [];
  for (const inst of payload?.timeline?.instructions || []) {
    for (const entry of inst?.addEntries?.entries || []) {
      const tweetId = entry?.content?.item?.content?.tweet?.id;
      if (!tweetId) continue;
      const tw = tweets[tweetId];
      const user = tw ? users[tw.user_id_str] : null;
      if (!tw || !user?.screen_name || seen.has(tweetId)) continue;
      seen.add(tweetId);
      rows.push({
        id: tweetId, author: user.screen_name, text: tw.full_text || tw.text || '',
        likes: tw.favorite_count ?? 0, retweets: tw.retweet_count ?? 0, replies: tw.reply_count ?? 0,
        views: null, created_at: tw.created_at || '', url: `https://x.com/${user.screen_name}/status/${tweetId}`,
      });
    }
  }
  return rows;
}

export default defineAdapter({
  description: 'The device-follow notification stream: tweets aggregated under a bell-icon "new posts from @userA and N others" notification.',
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'limit', type: 'int', default: 20, help: `How many tweets to return (1-${MAX_LIMIT})` },
    { name: 'top_by_engagement', type: 'int', default: 0, help: 'If >0, re-rank by weighted engagement and return the top N' },
  ],
  async run({ tab, args }) {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args.limit) || 20));
    await ensureOnX(tab);
    const headers = await authHeaders(tab);
    let data;
    try { data = await tab.fetchJson(buildUrl(limit), { headers }); }
    catch (e) { throw apiError('device_follow', e?.data?.status || e?.status || 0); }
    if (!data?.globalObjects) throw errors.upstream('device-follow response missing the expected timeline shape');
    const rows = parse(data, new Set());
    if (!rows.length) throw errors.empty('No device-follow notification tweets found');
    return applyTopByEngagement(rows.slice(0, limit), args.top_by_engagement);
  },
});
