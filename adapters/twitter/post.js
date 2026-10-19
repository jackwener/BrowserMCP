import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { mutate, statusUrl } from './_shared.js';

const newId = (d) => d?.data?.create_tweet?.tweet_results?.result?.rest_id;

export default defineAdapter({
  description: 'Post a new tweet.',
  access: 'write',
  domain: 'x.com',
  args: [{ name: 'text', type: 'string', required: true, help: 'Tweet text (<=280 chars for a standard account)' }],
  async run({ tab, args }) {
    const text = String(args.text ?? '');
    if (!text.trim()) throw errors.argument('text is required');
    const data = await mutate(tab, 'CreateTweet', { tweet_text: text, dark_request: false, media: { media_entities: [], possibly_sensitive: false }, semantic_annotation_ids: [] });
    const id = newId(data);
    return { ok: true, tweet_id: id, url: id ? statusUrl(id) : undefined };
  },
});
