import { defineAdapter } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnReddit, redditMe } from './_shared.js';

export default defineAdapter({
  description: 'The currently logged-in Reddit account.',
  access: 'read',
  domain: 'reddit.com',
  args: [],
  async run({ tab }) {
    await ensureOnReddit(tab);
    const u = await redditMe(tab);
    const created = u.created_utc ? new Date(u.created_utc * 1000).toISOString().split('T')[0] : undefined;
    const linkKarma = typeof u.link_karma === 'number' ? u.link_karma : undefined;
    const commentKarma = typeof u.comment_karma === 'number' ? u.comment_karma : undefined;
    return {
      username: `u/${u.name}`,
      id: u.id ? `t2_${u.id}` : undefined,
      post_karma: linkKarma,
      comment_karma: commentKarma,
      total_karma: typeof u.total_karma === 'number' ? u.total_karma : (linkKarma != null && commentKarma != null ? linkKarma + commentKarma : undefined),
      created,
      gold: Boolean(u.is_gold),
      mod: Boolean(u.is_mod),
      verified_email: Boolean(u.has_verified_email),
      has_mail: Boolean(u.has_mail),
      inbox_count: typeof u.inbox_count === 'number' ? u.inbox_count : undefined,
    };
  },
});
