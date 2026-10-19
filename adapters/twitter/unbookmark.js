import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { mutate, tweetIdFrom } from './_shared.js';

export default defineAdapter({
  description: 'Remove a tweet from your bookmarks.',
  access: 'write',
  domain: 'x.com',
  args: [{ name: 'tweet_id', type: 'string', required: true, help: 'Tweet numeric ID or a full status URL' }],
  async run({ tab, args }) {
    const id = tweetIdFrom(args.tweet_id);
    if (!id) throw errors.argument('tweet_id is required (numeric ID or status URL)');
    await mutate(tab, 'DeleteBookmark', { tweet_id: id }); return { ok: true, tweet_id: id, bookmarked: false };
  },
});
