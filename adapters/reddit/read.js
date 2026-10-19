import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnReddit, toPostId, redditPost } from './_shared.js';

const EXPAND_ROUNDS_MIN = 1;
const EXPAND_ROUNDS_MAX = 5;

export default defineAdapter({
  description: 'Read a Reddit post and a top-scored, threaded slice of its comments.',
  access: 'read',
  domain: 'reddit.com',
  args: [
    { name: 'post_id', type: 'string', required: true, help: 'Post id, t3_ fullname, or post URL' },
    { name: 'sort', type: 'string', default: 'best', choices: ['best', 'top', 'new', 'controversial', 'old', 'qa'], help: 'Comment sort' },
    { name: 'limit', type: 'int', default: 25, help: 'Number of top-level comments' },
    { name: 'depth', type: 'int', default: 2, help: 'Max reply depth (1 = no replies, 2 = one level of replies, etc.)' },
    { name: 'replies', type: 'int', default: 5, help: 'Max replies shown per comment at each level (by score)' },
    { name: 'max_length', type: 'int', default: 2000, help: 'Max characters per comment body (min 100)' },
    { name: 'expand_more', type: 'boolean', default: false, help: 'Follow Reddit "more comments" stubs via the morechildren API' },
    { name: 'expand_rounds', type: 'int', default: 2, help: `Max expansion passes when expand_more is on (${EXPAND_ROUNDS_MIN}-${EXPAND_ROUNDS_MAX})` },
  ],
  async run({ tab, args }) {
    const raw = String(args.post_id || '').trim();
    if (!raw) throw errors.argument('`post_id` is required', 'Give a post id, t3_ fullname, or post URL.');
    const postId = toPostId(raw);
    if (!/^[a-z0-9]+$/.test(postId)) throw errors.argument('Invalid post id', 'Use a post id like 1abc123, a t3_ fullname, or a reddit.com post URL.');
    const sort = ['best', 'top', 'new', 'controversial', 'old', 'qa'].includes(args.sort) ? args.sort : 'best';
    const limit = Math.max(1, Number(args.limit) || 25);
    const maxDepth = Math.max(1, Number(args.depth) || 2);
    const maxReplies = Math.max(1, Number(args.replies) || 5);
    const maxLength = Math.max(100, Number(args.max_length) || 2000);
    const expandMore = Boolean(args.expand_more);
    let expandRounds = Number(args.expand_rounds);
    if (!Number.isInteger(expandRounds) || expandRounds < EXPAND_ROUNDS_MIN || expandRounds > EXPAND_ROUNDS_MAX) expandRounds = 2;
    const linkFullname = `t3_${postId}`;

    await ensureOnReddit(tab);

    // Step 1: fetch post + initial comment tree.
    const apiLimit = Math.max(limit * 3, 100);
    let data;
    try {
      data = await tab.fetchJson(`https://www.reddit.com/comments/${postId}.json?sort=${sort}&limit=${apiLimit}&depth=${maxDepth + 1}&raw_json=1`);
    } catch {
      throw errors.empty(`Reddit post ${postId} is not accessible (private, removed, or not found)`);
    }
    if (!Array.isArray(data) || data.length < 2) throw errors.upstream(`Reddit /comments/${postId}.json had an unexpected shape`);
    const post = data[0]?.data?.children?.[0]?.data;
    if (!post) throw errors.upstream(`Reddit /comments/${postId}.json had no post body`);
    const topListing = Array.isArray(data[1]?.data?.children) ? data[1].data.children : null;
    if (!topListing) throw errors.upstream(`Reddit /comments/${postId}.json had no comment listing`);

    // Step 2: optionally follow "more" stubs via /api/morechildren.
    if (expandMore) {
      const collectMoreStubs = (arr, parentT1) => {
        const out = [];
        if (!Array.isArray(arr)) return out;
        for (const n of arr) {
          if (!n || !n.data) continue;
          if (n.kind === 'more' && Array.isArray(n.data.children) && n.data.children.length > 0) {
            out.push({ stub: n, hostArr: arr, hostT1: parentT1 });
          } else if (n.kind === 't1' && n.data.replies?.data?.children) {
            out.push(...collectMoreStubs(n.data.replies.data.children, n));
          }
        }
        return out;
      };
      for (let r = 0; r < expandRounds; r++) {
        const stubs = collectMoreStubs(topListing, null);
        if (!stubs.length) break;
        const allIds = [];
        for (const s of stubs) for (const c of s.stub.data.children) allIds.push(c);
        const uniqIds = [...new Set(allIds)];
        if (!uniqIds.length) break;
        const fetchedById = {};
        for (let b = 0; b < uniqIds.length; b += 100) {
          const batch = uniqIds.slice(b, b + 100);
          let mc;
          try {
            mc = await redditPost(tab, '/api/morechildren', { api_type: 'json', link_id: linkFullname, children: batch.join(','), sort, raw_json: '1' }, { needModhash: false });
          } catch {
            throw errors.upstream('Reddit /api/morechildren failed');
          }
          const things = mc?.json?.data?.things;
          if (!Array.isArray(things)) throw errors.upstream('Reddit /api/morechildren returned no things');
          for (const t of things) {
            if (!t?.data) continue;
            if (t.data.id) fetchedById[t.data.id] = t;
            if (t.data.name) fetchedById[t.data.name] = t;
          }
        }
        // Replace each stub in place with its fetched t1 children.
        for (const rec of stubs) {
          const idx = rec.hostArr.indexOf(rec.stub);
          if (idx < 0) continue;
          const replacements = [];
          for (const childId of rec.stub.data.children) {
            const rep = fetchedById[childId] || fetchedById[`t1_${childId}`];
            if (rep?.data) replacements.push(rep);
          }
          rec.hostArr.splice(idx, 1, ...replacements);
        }
      }
    }

    // Step 3: walk the (possibly augmented) tree into indented rows.
    const rows = [];
    let body = post.selftext || '';
    if (body.length > maxLength) body = `${body.slice(0, maxLength)}\n... [truncated]`;
    rows.push({
      type: 'POST',
      author: post.author || '[deleted]',
      score: post.score || 0,
      text: post.title + (body ? `\n\n${body}` : '') + (post.url && !post.is_self ? `\n${post.url}` : ''),
      link: post.url && !post.is_self ? post.url : undefined,
      permalink: post.permalink ? `https://www.reddit.com${post.permalink}` : undefined,
    });

    const walkComment = (node, depth) => {
      if (!node || node.kind !== 't1') return;
      const d = node.data;
      let cBody = d.body || '';
      if (cBody.length > maxLength) cBody = `${cBody.slice(0, maxLength)}...`;
      const indent = '  '.repeat(depth);
      const prefix = depth === 0 ? '' : `${indent}> `;
      const text = depth === 0 ? cBody : cBody.split('\n').map((l) => prefix + l).join('\n');
      rows.push({ type: depth === 0 ? 'L0' : `L${depth}`, author: d.author || '[deleted]', score: d.score || 0, text });

      const t1Children = [];
      let moreCount = 0;
      const children = d.replies?.data?.children || [];
      for (const c of children) {
        if (c.kind === 't1') t1Children.push(c);
        else if (c.kind === 'more') moreCount += c.data.count || 0;
      }
      if (depth + 1 >= maxDepth) {
        const totalHidden = t1Children.length + moreCount;
        if (totalHidden > 0) rows.push({ type: `L${depth + 1}`, author: '', score: '', text: `${'  '.repeat(depth + 1)}[+${totalHidden} more replies]` });
        return;
      }
      t1Children.sort((a, b) => (b.data.score || 0) - (a.data.score || 0));
      const toProcess = Math.min(t1Children.length, maxReplies);
      for (let i = 0; i < toProcess; i++) walkComment(t1Children[i], depth + 1);
      const hidden = t1Children.length - toProcess + moreCount;
      if (hidden > 0) rows.push({ type: `L${depth + 1}`, author: '', score: '', text: `${'  '.repeat(depth + 1)}[+${hidden} more replies]` });
    };

    const t1TopLevel = topListing.filter((c) => c.kind === 't1');
    for (let i = 0; i < Math.min(t1TopLevel.length, limit); i++) walkComment(t1TopLevel[i], 0);

    const moreTopLevel = topListing.filter((c) => c.kind === 'more').reduce((sum, c) => sum + (c.data.count || 0), 0);
    const hiddenTopLevel = Math.max(0, t1TopLevel.length - limit) + moreTopLevel;
    if (hiddenTopLevel > 0) rows.push({ type: '', author: '', score: '', text: `[+${hiddenTopLevel} more top-level comments]` });

    return rows;
  },
});
