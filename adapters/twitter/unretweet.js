import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { mutate, tweetIdFrom } from './_shared.js';

export default defineAdapter({
  description: 'Undo your retweet of a tweet.',
  access: 'write',
  domain: 'x.com',
  args: [{ name: 'tweet_id', type: 'string', required: true, help: 'The ORIGINAL tweet numeric ID or status URL (not your retweet)' }],
  async run({ tab, args }) {
    const id = tweetIdFrom(args.tweet_id);
    if (!id) throw errors.argument('tweet_id is required (numeric ID or status URL)');
    await mutate(tab, 'DeleteRetweet', { source_tweet_id: id, dark_request: false });
    return { ok: true, tweet_id: id, retweeted: false };
  },
});
