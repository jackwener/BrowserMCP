import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnReddit } from './_shared.js';

const SUBREDDIT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{2,20}$/;

export default defineAdapter({
  description: 'Metadata for a subreddit (subscribers, description, created date, NSFW).',
  access: 'read',
  domain: 'reddit.com',
  args: [
    { name: 'name', type: 'string', required: true, help: 'Subreddit name without r/' },
  ],
  async run({ tab, args }) {
    let sub = String(args.name || '').trim().replace(/^\/?r\//, '');
    if (!sub) throw errors.argument('`name` is required', 'Give a subreddit name, e.g. { name: "python" }');
    if (!SUBREDDIT_NAME_RE.test(sub)) throw errors.argument('Invalid subreddit name', 'Subreddit names are 3-21 characters, start with a letter, and contain only letters, digits, and underscores.');
    await ensureOnReddit(tab);
    let json;
    try {
      json = await tab.fetchJson(`https://www.reddit.com/r/${encodeURIComponent(sub)}/about.json?raw_json=1`);
    } catch {
      throw errors.empty(`Subreddit r/${sub} was not found or is not accessible`);
    }
    if (json?.error) throw errors.empty(`Subreddit r/${sub} is ${json.reason || 'unavailable'}`);
    const s = json?.data;
    if (!s || !s.display_name) throw errors.empty(`Subreddit r/${sub} was not found or is not accessible`);
    return {
      name: s.display_name_prefixed || `r/${s.display_name}`,
      title: s.title || undefined,
      subscribers: typeof s.subscribers === 'number' ? s.subscribers : undefined,
      active_now: typeof s.active_user_count === 'number' ? s.active_user_count : (typeof s.accounts_active === 'number' ? s.accounts_active : undefined),
      nsfw: Boolean(s.over18),
      type: s.subreddit_type || undefined,
      description: (typeof s.public_description === 'string' ? s.public_description.trim() : '') || undefined,
      created: s.created_utc ? new Date(s.created_utc * 1000).toISOString().split('T')[0] : undefined,
      permalink: s.url ? `https://www.reddit.com${s.url}` : undefined,
    };
  },
});
