import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnX, gql, resolveLoggedInUser, normalizeScreenName, USER_BY_SCREEN_NAME_QUERY_ID, USER_BY_SCREEN_NAME_FEATURES, apiError } from './_shared.js';

const str = (v) => (typeof v === 'string' ? v : '');
const count = (...vals) => { for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v; return 0; };

export default defineAdapter({
  description: 'An X user profile: bio, location, website, follower/following/tweet counts, verified status (defaults to the logged-in user).',
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'username', type: 'string', help: 'Screen name (with or without @). Omit for the logged-in user.' },
  ],
  async run({ tab, args }) {
    await ensureOnX(tab);
    const raw = String(args.username || '').trim();
    let username = raw ? normalizeScreenName(raw) : '';
    if (raw && !username) throw errors.argument('username must be a valid X handle', 'Example: { username: "jack" }');
    if (!username) username = await resolveLoggedInUser(tab);
    let data;
    try { data = await gql(tab, USER_BY_SCREEN_NAME_QUERY_ID, 'UserByScreenName', { screen_name: username, withSafetyModeUserFields: true }, { features: USER_BY_SCREEN_NAME_FEATURES }); }
    catch (e) { throw apiError('UserByScreenName', e?.data?.status || e?.status || 0, 'user may not exist'); }
    const result = data?.data?.user?.result;
    if (!result || typeof result !== 'object') throw errors.empty(`User @${username} not found`);
    const legacy = result.legacy && typeof result.legacy === 'object' ? result.legacy : {};
    const core = result.core && typeof result.core === 'object' ? result.core : {};
    const location = result.location && typeof result.location === 'object' ? result.location : {};
    const url = str(result.website?.url) || str(legacy.entities?.url?.urls?.[0]?.expanded_url);
    return {
      screen_name: str(core.screen_name) || str(legacy.screen_name) || username,
      name: str(core.name) || str(legacy.name),
      bio: str(result.profile_bio?.description) || str(legacy.description),
      location: str(location.location) || str(legacy.location),
      url,
      followers: count(result.relationship_counts?.followers, legacy.followers_count, legacy.normal_followers_count),
      following: count(result.relationship_counts?.following, legacy.friends_count),
      tweets: count(result.tweet_counts?.tweets, legacy.statuses_count),
      likes: count(result.action_counts?.favorites_count, legacy.favourites_count),
      verified: Boolean(result.is_blue_verified || result.verification?.verified || legacy.verified),
      created_at: str(core.created_at) || str(legacy.created_at),
    };
  },
});
