import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnReddit, redditMe } from './_shared.js';

export default defineAdapter({
  description: 'Subreddits you are subscribed to. Requires being logged in.',
  access: 'read',
  domain: 'reddit.com',
  args: [
    { name: 'limit', type: 'int', default: 100, help: 'Max subreddits to return (auto-paginates)' },
  ],
  async run({ tab, args }) {
    await ensureOnReddit(tab);
    await redditMe(tab);
    const target = Math.min(Math.max(1, Number(args.limit) || 100), 1000);
    const out = [];
    let after = null;
    const seen = new Set();
    for (let page = 0; page < 20 && out.length < target; page++) {
      const pageLimit = Math.min(100, target - out.length);
      const url = `https://www.reddit.com/subreddits/mine/subscriptions.json?limit=${pageLimit}&raw_json=1${after ? `&after=${encodeURIComponent(after)}` : ''}`;
      const json = await tab.fetchJson(url);
      const children = json?.data?.children;
      if (!Array.isArray(children)) throw errors.upstream('Reddit: subscriptions payload was missing data.children');
      for (const c of children) {
        if (out.length >= target) break;
        const d = c?.data || {};
        out.push({
          id: d.name || (d.id ? `t5_${d.id}` : undefined),
          subreddit: d.display_name_prefixed || (d.display_name ? `r/${d.display_name}` : undefined),
          title: d.title || undefined,
          subscribers: typeof d.subscribers === 'number' ? d.subscribers : undefined,
          description: typeof d.public_description === 'string' ? d.public_description.slice(0, 200) : undefined,
          permalink: d.url ? `https://www.reddit.com${d.url}` : undefined,
        });
      }
      after = json?.data?.after || null;
      if (!after || children.length === 0 || seen.has(after)) break;
      seen.add(after);
    }
    if (!out.length) throw errors.empty('You are not subscribed to any subreddits');
    return out;
  },
});
