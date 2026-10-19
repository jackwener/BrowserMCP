import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnReddit, postRows, assertListing } from './_shared.js';

export default defineAdapter({
  description: 'Posts from a subreddit (or your front page if subreddit is omitted).',
  access: 'read',
  domain: 'reddit.com',
  args: [
    { name: 'subreddit', type: 'string', help: 'Subreddit name without r/ (omit for your front page)' },
    { name: 'sort', type: 'string', default: 'hot', choices: ['hot', 'new', 'top', 'rising'], help: 'Listing sort' },
    { name: 'limit', type: 'int', default: 25, help: 'How many posts to return' },
    { name: 'cursor', type: 'string', help: 'nextCursor (fullname) from a previous call, to page further' },
  ],
  async run({ tab, args }) {
    await ensureOnReddit(tab);
    const sub = String(args.subreddit || '').replace(/^\/?r\//, '').trim();
    const sort = ['hot', 'new', 'top', 'rising'].includes(args.sort) ? args.sort : 'hot';
    const limit = Math.min(Math.max(1, Number(args.limit) || 25), 100);
    const base = sub ? `https://www.reddit.com/r/${encodeURIComponent(sub)}/${sort}.json` : `https://www.reddit.com/${sort}.json`;
    const after = args.cursor ? `&after=${encodeURIComponent(String(args.cursor))}` : '';
    const json = await tab.fetchJson(`${base}?limit=${limit}${after}&raw_json=1`);
    assertListing(json);
    const rows = postRows(json);
    if (!rows.length) throw errors.empty(sub ? `No posts in r/${sub}` : 'No posts on your front page');
    return { rows, ...(json.data?.after && { nextCursor: json.data.after }) };
  },
});
