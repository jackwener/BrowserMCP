import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { mutate, tweetIdFrom } from './_shared.js';

export default defineAdapter({
  description: 'Hide a reply to one of your tweets (or unhide it with unhide:true).',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'tweet_id', type: 'string', required: true, help: 'The reply tweet to hide (numeric ID or status URL)' },
    { name: 'unhide', type: 'boolean', default: false, help: 'Set true to unhide instead' },
  ],
  async run({ tab, args }) {
    const id = tweetIdFrom(args.tweet_id);
    if (!id) throw errors.argument('tweet_id is required');
    const op = args.unhide ? 'UnmoderateTweet' : 'ModerateTweet';
    await mutate(tab, op, { tweetId: id });
    return { ok: true, tweet_id: id, hidden: !args.unhide };
  },
});
