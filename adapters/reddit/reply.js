import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnReddit, redditPost, toCommentFullname } from './_shared.js';

export default defineAdapter({
  description: 'Reply to a Reddit comment.',
  access: 'write',
  domain: 'reddit.com',
  args: [
    { name: 'comment_id', type: 'string', required: true, help: 'Comment id, t1_ fullname, or comment URL' },
    { name: 'text', type: 'string', required: true, help: 'Reply text' },
  ],
  async run({ tab, args }) {
    const raw = String(args.comment_id || '').trim();
    if (!raw) throw errors.argument('`comment_id` is required', 'Give a comment id, t1_ fullname, or comment URL.');
    const text = String(args.text ?? '');
    if (!text.trim()) throw errors.argument('`text` is required', 'Give non-empty reply text.');
    await ensureOnReddit(tab);
    const parent = toCommentFullname(raw);
    const json = await redditPost(tab, '/api/comment', { parent, text, api_type: 'json' });
    const things = json?.json?.data?.things;
    const created = Array.isArray(things) ? things.find((t) => t?.kind === 't1' || String(t?.data?.name || '').startsWith('t1_')) : null;
    const createdName = created?.data?.name || (created?.data?.id ? `t1_${created.data.id}` : undefined);
    const permalink = created?.data?.permalink ? `https://www.reddit.com${created.data.permalink}` : undefined;
    return { ok: true, action: 'replied', parent, comment_id: createdName, permalink };
  },
});
