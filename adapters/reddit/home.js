import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnReddit, postRows, assertListing, redditMe } from './_shared.js';

export default defineAdapter({
  description: 'Your personalized Reddit home feed (Best). Requires being logged in.',
  access: 'read',
  domain: 'reddit.com',
  args: [
    { name: 'limit', type: 'int', default: 25, help: 'How many posts to return' },
    { name: 'cursor', type: 'string', help: 'nextCursor (fullname) from a previous call, to page further' },
  ],
  async run({ tab, args }) {
    await ensureOnReddit(tab);
    // The Best feed is personalized only when logged in; anonymous sessions get a
    // generic listing that overlaps r/all. Require auth so `home` is meaningful.
    await redditMe(tab);
    const limit = Math.min(Math.max(1, Number(args.limit) || 25), 100);
    const after = args.cursor ? `&after=${encodeURIComponent(String(args.cursor))}` : '';
    const json = await tab.fetchJson(`https://www.reddit.com/best.json?limit=${limit}${after}&raw_json=1`);
    assertListing(json);
    const rows = postRows(json);
    if (!rows.length) throw errors.empty('No posts in your personalized home feed');
    return { rows, ...(json.data?.after && { nextCursor: json.data.after }) };
  },
});
