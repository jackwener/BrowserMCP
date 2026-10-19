import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { mutate, tweetIdFrom, statusUrl } from './_shared.js';

const newId = (d) => d?.data?.create_tweet?.tweet_results?.result?.rest_id;

export default defineAdapter({
  description: 'Quote-tweet a tweet (retweet with your own comment).',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'tweet_id', type: 'string', required: true, help: 'The tweet to quote (numeric ID or status URL)' },
    { name: 'text', type: 'string', required: true, help: 'Your comment' },
  ],
  async run({ tab, args }) {
    const quoted = tweetIdFrom(args.tweet_id);
    const text = String(args.text ?? '');
    if (!quoted) throw errors.argument('tweet_id is required');
    if (!text.trim()) throw errors.argument('text is required');
    const data = await mutate(tab, 'CreateTweet', { tweet_text: text, dark_request: false, media: { media_entities: [], possibly_sensitive: false }, semantic_annotation_ids: [], attachment_url: statusUrl(quoted) });
    const id = newId(data);
    return { ok: true, tweet_id: id, quoted_tweet_id: quoted, url: id ? statusUrl(id) : undefined };
  },
});
