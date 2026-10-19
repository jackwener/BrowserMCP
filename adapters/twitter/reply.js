import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { mutate, tweetIdFrom, statusUrl } from './_shared.js';

const newId = (d) => d?.data?.create_tweet?.tweet_results?.result?.rest_id;

export default defineAdapter({
  description: 'Reply to a tweet.',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'tweet_id', type: 'string', required: true, help: 'The tweet to reply to (numeric ID or status URL)' },
    { name: 'text', type: 'string', required: true, help: 'Reply text' },
  ],
  async run({ tab, args }) {
    const replyTo = tweetIdFrom(args.tweet_id);
    const text = String(args.text ?? '');
    if (!replyTo) throw errors.argument('tweet_id is required');
    if (!text.trim()) throw errors.argument('text is required');
    const data = await mutate(tab, 'CreateTweet', { tweet_text: text, dark_request: false, media: { media_entities: [], possibly_sensitive: false }, semantic_annotation_ids: [], reply: { in_reply_to_tweet_id: replyTo, exclude_reply_user_ids: [] } });
    const id = newId(data);
    return { ok: true, tweet_id: id, in_reply_to: replyTo, url: id ? statusUrl(id) : undefined };
  },
});
