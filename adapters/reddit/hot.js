import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnReddit, postRows, assertListing } from './_shared.js';

export default defineAdapter({
  description: 'Hot posts from a subreddit, or the frontpage if subreddit is omitted.',
  access: 'read',
  domain: 'reddit.com',
  args: [
    { name: 'subreddit', type: 'string', help: 'Subreddit name without r/ (omit for the frontpage)' },
    { name: 'limit', type: 'int', default: 20, help: 'How many posts to return' },
    { name: 'cursor', type: 'string', help: 'nextCursor (fullname) from a previous call, to page further' },
  ],
  async run({ tab, args }) {
    await ensureOnReddit(tab);
    const sub = String(args.subreddit || '').replace(/^\/?r\//, '').trim();
    const limit = Math.min(Math.max(1, Number(args.limit) || 20), 100);
    const base = sub ? `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.json` : 'https://www.reddit.com/hot.json';
    const after = args.cursor ? `&after=${encodeURIComponent(String(args.cursor))}` : '';
    const json = await tab.fetchJson(`${base}?limit=${limit}${after}&raw_json=1`);
    assertListing(json);
    const rows = postRows(json);
    if (!rows.length) throw errors.empty(sub ? `No hot posts in r/${sub}` : 'No hot posts on the frontpage');
    return { rows, ...(json.data?.after && { nextCursor: json.data.after }) };
  },
});
