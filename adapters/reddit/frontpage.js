import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnReddit, postRows, assertListing } from './_shared.js';

export default defineAdapter({
  description: 'Posts from the public Reddit frontpage (r/all).',
  access: 'read',
  domain: 'reddit.com',
  args: [
    { name: 'limit', type: 'int', default: 25, help: 'How many posts to return' },
    { name: 'cursor', type: 'string', help: 'nextCursor (fullname) from a previous call, to page further' },
  ],
  async run({ tab, args }) {
    await ensureOnReddit(tab);
    const limit = Math.min(Math.max(1, Number(args.limit) || 25), 100);
    const after = args.cursor ? `&after=${encodeURIComponent(String(args.cursor))}` : '';
    const json = await tab.fetchJson(`https://www.reddit.com/r/all.json?limit=${limit}${after}&raw_json=1`);
    assertListing(json);
    const rows = postRows(json);
    if (!rows.length) throw errors.empty('No posts on r/all');
    return { rows, ...(json.data?.after && { nextCursor: json.data.after }) };
  },
});
