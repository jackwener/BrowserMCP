import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnReddit, mixedRows, assertListing, redditMe } from './_shared.js';

export default defineAdapter({
  description: 'Your saved Reddit posts and comments. Requires being logged in.',
  access: 'read',
  domain: 'reddit.com',
  args: [
    { name: 'limit', type: 'int', default: 25, help: 'How many items to return' },
    { name: 'cursor', type: 'string', help: 'nextCursor (fullname) from a previous call, to page further' },
  ],
  async run({ tab, args }) {
    await ensureOnReddit(tab);
    const me = await redditMe(tab);
    const limit = Math.min(Math.max(1, Number(args.limit) || 25), 100);
    const after = args.cursor ? `&after=${encodeURIComponent(String(args.cursor))}` : '';
    const json = await tab.fetchJson(`https://www.reddit.com/user/${encodeURIComponent(me.name)}/saved.json?limit=${limit}${after}&raw_json=1`);
    assertListing(json);
    const rows = mixedRows(json);
    if (!rows.length) throw errors.empty('No saved items');
    return { rows, ...(json.data?.after && { nextCursor: json.data.after }) };
  },
});
