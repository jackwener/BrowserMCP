import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { mutate, tweetIdFrom } from './_shared.js';

export default defineAdapter({
  description: 'Delete one of your own tweets.',
  access: 'write',
  domain: 'x.com',
  args: [{ name: 'tweet_id', type: 'string', required: true, help: 'Tweet numeric ID or a full status URL' }],
  async run({ tab, args }) {
    const id = tweetIdFrom(args.tweet_id);
    if (!id) throw errors.argument('tweet_id is required (numeric ID or status URL)');
    await mutate(tab, 'DeleteTweet', { tweet_id: id, dark_request: false }); return { ok: true, tweet_id: id, deleted: true };
  },
});
