import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnReddit, redditPost, toPostFullname } from './_shared.js';

export default defineAdapter({
  description: 'Save or unsave a Reddit post.',
  access: 'write',
  domain: 'reddit.com',
  args: [
    { name: 'post_id', type: 'string', required: true, help: 'Post id, t3_ fullname, or post URL' },
    { name: 'undo', type: 'boolean', default: false, help: 'Unsave instead of save' },
  ],
  async run({ tab, args }) {
    const raw = String(args.post_id || '').trim();
    if (!raw) throw errors.argument('`post_id` is required', 'Give a post id, t3_ fullname, or post URL.');
    await ensureOnReddit(tab);
    const fullname = toPostFullname(raw);
    const undo = Boolean(args.undo);
    await redditPost(tab, undo ? '/api/unsave' : '/api/save', { id: fullname });
    return { ok: true, action: undo ? 'unsaved' : 'saved', id: fullname };
  },
});
