import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnReddit, postRows, assertListing } from './_shared.js';

export default defineAdapter({
  description: 'Search Reddit posts (optionally within a subreddit).',
  access: 'read',
  domain: 'reddit.com',
  args: [
    { name: 'query', type: 'string', required: true, help: 'Search text' },
    { name: 'subreddit', type: 'string', help: 'Restrict to this subreddit (without r/)' },
    { name: 'sort', type: 'string', default: 'relevance', choices: ['relevance', 'hot', 'top', 'new', 'comments'], help: 'Result sort' },
    { name: 'limit', type: 'int', default: 25, help: 'How many results to return' },
    { name: 'cursor', type: 'string', help: 'nextCursor (fullname) from a previous call' },
  ],
  async run({ tab, args }) {
    const query = String(args.query || '').trim();
    if (!query) throw errors.argument('`query` is required', 'Give search text, e.g. { query: "mechanical keyboards" }');
    await ensureOnReddit(tab);
    const sub = String(args.subreddit || '').replace(/^\/?r\//, '').trim();
    const sort = ['relevance', 'hot', 'top', 'new', 'comments'].includes(args.sort) ? args.sort : 'relevance';
    const limit = Math.min(Math.max(1, Number(args.limit) || 25), 100);
    const base = sub ? `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json` : `https://www.reddit.com/search.json`;
    const restrict = sub ? '&restrict_sr=1' : '';
    const after = args.cursor ? `&after=${encodeURIComponent(String(args.cursor))}` : '';
    const json = await tab.fetchJson(`${base}?q=${encodeURIComponent(query)}&sort=${sort}&limit=${limit}${restrict}${after}&raw_json=1`);
    assertListing(json);
    const rows = postRows(json);
    if (!rows.length) throw errors.empty(`No results for "${query}"`);
    return { rows, ...(json.data?.after && { nextCursor: json.data.after }) };
  },
});
