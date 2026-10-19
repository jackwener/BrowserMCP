import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnReddit } from './_shared.js';

export default defineAdapter({
  description: 'A Reddit user profile (karma, account age, status).',
  access: 'read',
  domain: 'reddit.com',
  args: [
    { name: 'username', type: 'string', required: true, help: 'Reddit username without u/' },
  ],
  async run({ tab, args }) {
    const name = String(args.username || '').replace(/^\/?u\//, '').trim();
    if (!name) throw errors.argument('`username` is required', 'Give a Reddit username, e.g. { username: "spez" }');
    await ensureOnReddit(tab);
    let json;
    try {
      json = await tab.fetchJson(`https://www.reddit.com/user/${encodeURIComponent(name)}/about.json?raw_json=1`);
    } catch {
      throw errors.empty(`Reddit user u/${name} was not found or is not accessible`);
    }
    const u = json?.data || json || {};
    if (!u.name) throw errors.empty(`Reddit user u/${name} was not found or is not accessible`);
    const created = u.created_utc ? new Date(u.created_utc * 1000).toISOString().split('T')[0] : '-';
    return {
      username: `u/${u.name}`,
      id: u.id ? `t2_${u.id}` : undefined,
      post_karma: u.link_karma || 0,
      comment_karma: u.comment_karma || 0,
      total_karma: u.total_karma ?? ((u.link_karma || 0) + (u.comment_karma || 0)),
      created,
      gold: Boolean(u.is_gold),
      verified: Boolean(u.verified),
      permalink: `https://www.reddit.com/user/${u.name}`,
    };
  },
});
