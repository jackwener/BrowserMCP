import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnReddit, postRows, assertListing } from './_shared.js';

export default defineAdapter({
  description: 'Popular posts across Reddit (r/popular).',
  access: 'read',
  domain: 'reddit.com',
  args: [
    { name: 'limit', type: 'int', default: 20, help: 'How many posts to return' },
    { name: 'cursor', type: 'string', help: 'nextCursor (fullname) from a previous call, to page further' },
  ],
  async run({ tab, args }) {
    await ensureOnReddit(tab);
    const limit = Math.min(Math.max(1, Number(args.limit) || 20), 100);
    const after = args.cursor ? `&after=${encodeURIComponent(String(args.cursor))}` : '';
    const json = await tab.fetchJson(`https://www.reddit.com/r/popular.json?limit=${limit}${after}&raw_json=1`);
    assertListing(json);
    const rows = postRows(json);
    if (!rows.length) throw errors.empty('No popular posts');
    return { rows, ...(json.data?.after && { nextCursor: json.data.after }) };
  },
});
