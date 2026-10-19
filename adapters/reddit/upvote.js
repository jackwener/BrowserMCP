import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnReddit, redditPost, toPostFullname } from './_shared.js';

export default defineAdapter({
  description: 'Upvote, downvote, or clear your vote on a Reddit post.',
  access: 'write',
  domain: 'reddit.com',
  args: [
    { name: 'post_id', type: 'string', required: true, help: 'Post id, t3_ fullname, or post URL' },
    { name: 'direction', type: 'string', default: 'up', choices: ['up', 'down', 'none'], help: 'Vote direction (none clears the vote)' },
  ],
  async run({ tab, args }) {
    const raw = String(args.post_id || '').trim();
    if (!raw) throw errors.argument('`post_id` is required', 'Give a post id, t3_ fullname, or post URL.');
    await ensureOnReddit(tab);
    const fullname = toPostFullname(raw);
    const dirArg = String(args.direction || 'up');
    const dir = dirArg === 'down' ? -1 : dirArg === 'none' ? 0 : 1;
    await redditPost(tab, '/api/vote', { id: fullname, dir: String(dir) });
    const label = dir === 1 ? 'upvoted' : dir === -1 ? 'downvoted' : 'vote cleared';
    return { ok: true, action: label, id: fullname };
  },
});
