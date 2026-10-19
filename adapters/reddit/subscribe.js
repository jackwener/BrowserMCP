import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnReddit, redditPost } from './_shared.js';

export default defineAdapter({
  description: 'Subscribe to or unsubscribe from a subreddit.',
  access: 'write',
  domain: 'reddit.com',
  args: [
    { name: 'subreddit', type: 'string', required: true, help: 'Subreddit name without r/' },
    { name: 'undo', type: 'boolean', default: false, help: 'Unsubscribe instead of subscribe' },
  ],
  async run({ tab, args }) {
    const sub = String(args.subreddit || '').replace(/^\/?r\//, '').trim();
    if (!sub) throw errors.argument('`subreddit` is required', 'Give a subreddit name, e.g. { subreddit: "python" }');
    await ensureOnReddit(tab);
    const undo = Boolean(args.undo);
    await redditPost(tab, '/api/subscribe', { sr_name: sub, action: undo ? 'unsub' : 'sub' });
    return { ok: true, action: undo ? 'unsubscribed' : 'subscribed', subreddit: `r/${sub}` };
  },
});
