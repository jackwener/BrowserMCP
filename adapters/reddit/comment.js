import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnReddit, redditPost, toPostFullname } from './_shared.js';

export default defineAdapter({
  description: 'Post a top-level comment on a Reddit post.',
  access: 'write',
  domain: 'reddit.com',
  args: [
    { name: 'post_id', type: 'string', required: true, help: 'Post id, t3_ fullname, or post URL' },
    { name: 'text', type: 'string', required: true, help: 'Comment text' },
  ],
  async run({ tab, args }) {
    const raw = String(args.post_id || '').trim();
    if (!raw) throw errors.argument('`post_id` is required', 'Give a post id, t3_ fullname, or post URL.');
    const text = String(args.text ?? '');
    if (!text.trim()) throw errors.argument('`text` is required', 'Give non-empty comment text.');
    await ensureOnReddit(tab);
    const parent = toPostFullname(raw);
    const json = await redditPost(tab, '/api/comment', { parent, text, api_type: 'json' });
    const things = json?.json?.data?.things;
    const created = Array.isArray(things) ? things.find((t) => t?.kind === 't1' || String(t?.data?.name || '').startsWith('t1_')) : null;
    const createdName = created?.data?.name || (created?.data?.id ? `t1_${created.data.id}` : undefined);
    const permalink = created?.data?.permalink ? `https://www.reddit.com${created.data.permalink}` : undefined;
    return { ok: true, action: 'commented', parent, comment_id: createdName, permalink };
  },
});
