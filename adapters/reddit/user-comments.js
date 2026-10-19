import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnReddit, commentRows, assertListing } from './_shared.js';

export default defineAdapter({
  description: "A Reddit user's comment history.",
  access: 'read',
  domain: 'reddit.com',
  args: [
    { name: 'username', type: 'string', required: true, help: 'Reddit username without u/' },
    { name: 'limit', type: 'int', default: 25, help: 'How many comments to return' },
    { name: 'cursor', type: 'string', help: 'nextCursor (fullname) from a previous call, to page further' },
  ],
  async run({ tab, args }) {
    const name = String(args.username || '').replace(/^\/?u\//, '').trim();
    if (!name) throw errors.argument('`username` is required', 'Give a Reddit username, e.g. { username: "spez" }');
    await ensureOnReddit(tab);
    const limit = Math.min(Math.max(1, Number(args.limit) || 25), 100);
    const after = args.cursor ? `&after=${encodeURIComponent(String(args.cursor))}` : '';
    const json = await tab.fetchJson(`https://www.reddit.com/user/${encodeURIComponent(name)}/comments.json?limit=${limit}${after}&raw_json=1`);
    assertListing(json);
    const rows = commentRows(json);
    if (!rows.length) throw errors.empty(`No comments from u/${name}`);
    return { rows, ...(json.data?.after && { nextCursor: json.data.after }) };
  },
});
