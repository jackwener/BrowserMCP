import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureLinkedIn, integer } from './_shared.js';
import { collectProfilePosts, linkedinProfile, profileIdentity } from './_profile.js';

export function summarizePosts(posts) {
  if (!Array.isArray(posts) || !posts.length) throw errors.empty('No LinkedIn profile activity posts were found');
  const sum = (field) => posts.reduce((total, post) => total + Number(post[field] || 0), 0);
  const latest = posts[0];
  return {
    posts_analyzed: posts.length,
    total_reactions: sum('reactions'), total_comments: sum('comments'),
    total_reposts: sum('reposts'), total_impressions: sum('impressions'),
    posts_with_media: posts.filter((post) => post.media).length,
    posts_with_urls: posts.filter((post) => post.url).length,
    latest_posted_at: latest.posted_at,
    latest_reactions: latest.reactions, latest_comments: latest.comments,
    latest_reposts: latest.reposts, latest_impressions: latest.impressions,
    latest_url: latest.url,
  };
}

export default defineAdapter({
  description: 'Summarize LinkedIn profile activity counters from the Voyager member feed API.',
  access: 'read', domain: 'linkedin.com',
  result: { kind: 'rows', description: 'Profile activity analytics' },
  args: [
    { name: 'profile_url', type: 'string', help: 'LinkedIn /in/<handle>/ URL; defaults to your profile' },
    { name: 'limit', type: 'int', default: 30, min: 1, max: 100 },
  ],
  async run({ tab, args }) {
    const identity = profileIdentity(args.profile_url);
    const limit = integer(args.limit, 'limit', 30, 1, 100);
    await ensureLinkedIn(tab);
    const profile = await linkedinProfile(tab, identity);
    const { rows } = await collectProfilePosts(tab, profile, limit);
    return { rows: [summarizePosts(rows)] };
  },
});
