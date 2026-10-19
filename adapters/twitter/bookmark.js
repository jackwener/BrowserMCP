import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { mutate, tweetIdFrom } from './_shared.js';

export default defineAdapter({
  description: 'Bookmark a tweet.',
  access: 'write',
  domain: 'x.com',
  args: [{ name: 'tweet_id', type: 'string', required: true, help: 'Tweet numeric ID or a full status URL' }],
  async run({ tab, args }) {
    const id = tweetIdFrom(args.tweet_id);
    if (!id) throw errors.argument('tweet_id is required (numeric ID or status URL)');
    await mutate(tab, 'CreateBookmark', { tweet_id: id }); return { ok: true, tweet_id: id, bookmarked: true };
  },
});
