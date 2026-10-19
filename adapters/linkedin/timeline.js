import { defineAdapter } from 'browsermcp/adapter-sdk';
import { ensureLinkedIn, integer, linkedinApi, requireElements } from './_shared.js';
import { mapProfileUpdate } from './_profile.js';

export default defineAdapter({
  description: 'Read LinkedIn home feed posts through the Voyager main feed API.',
  access: 'read', domain: 'linkedin.com',
  result: { kind: 'rows', description: 'Home timeline posts' },
  args: [
    { name: 'limit', type: 'int', default: 20, min: 1, max: 100 },
  ],
  async run({ tab, args }) {
    const limit = integer(args.limit, 'limit', 20, 1, 100);
    let start = 0;
    let token = '';
    await ensureLinkedIn(tab);
    const rows = [];
    const seen = new Set();
    for (let page = 0; page < 10 && rows.length < limit; page++) {
      const count = Math.min(100, Math.max(20, limit - rows.length + 10));
      const params = new URLSearchParams({ q: 'mainFeed', count: String(count), start: String(start) });
      if (token) params.set('paginationToken', token);
      const response = await linkedinApi(tab, `/voyager/api/voyagerFeedDashMainFeed?${params}`);
      const elements = requireElements(response, 'LinkedIn main feed');
      for (const element of elements) {
        const post = mapProfileUpdate(element, rows.length + 1);
        if (!post?.author || (!post.body && !post.url) || seen.has(post.id)) continue;
        seen.add(post.id);
        rows.push({
          rank: rows.length + 1, id: post.id, author: post.author,
          author_url: post.author_url, headline: element?.actor?.description?.text || null,
          text: post.body, posted_at: post.posted_at,
          reactions: post.reactions, comments: post.comments, reposts: post.reposts,
          url: post.url, media: post.media, media_urls: post.media_urls,
        });
        if (rows.length >= limit) break;
      }
      const next = String(response.metadata?.paginationToken || '');
      start += elements.length;
      if (!next || next === token || !elements.length) return { rows };
      token = next;
    }
    return { rows };
  },
});
