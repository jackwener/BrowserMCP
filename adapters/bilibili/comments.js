import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnBili, biliApi, biliApiSigned, resolveBvid } from './_shared.js';

const MAX_LIMIT = 50;

function formatReplyRow(reply, index) {
  const rpid = String(reply?.rpid ?? '').trim();
  const ctime = Number(reply?.ctime);
  return {
    rank: index + 1,
    rpid,
    author: String(reply?.member?.uname ?? ''),
    text: String(reply?.content?.message ?? '').replace(/\n/g, ' ').trim(),
    likes: reply?.like ?? 0,
    replies: reply?.rcount ?? 0,
    time: Number.isFinite(ctime) ? new Date(ctime * 1000).toISOString() : '',
  };
}

export default defineAdapter({
  description: 'Comments on a Bilibili video. With parent set, fetches the replies nested under that comment instead of top-level comments.',
  access: 'read',
  domain: 'bilibili.com',
  args: [
    { name: 'bvid', type: 'string', required: true, help: 'BV id, video URL, or b23.tv short link' },
    { name: 'parent', type: 'int', help: 'rpid of a comment — fetch replies under it instead of top-level comments' },
    { name: 'limit', type: 'int', default: 20, help: 'How many comments to return (max 50)' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const bvid = await resolveBvid(args.bvid);
    const limit = Math.min(Math.max(1, Number(args.limit) || 20), MAX_LIMIT);
    const parent = args.parent != null ? Number(args.parent) : null;

    const viewData = await biliApi(tab, '/x/web-interface/view', { bvid });
    const aid = viewData?.aid;
    if (!aid) throw errors.upstream(`Cannot resolve aid for bvid: ${bvid}`);

    const data = parent != null
      ? await biliApi(tab, '/x/v2/reply/reply', { oid: aid, type: 1, root: parent, pn: 1, ps: limit })
      : await biliApiSigned(tab, '/x/v2/reply/main', { oid: aid, type: 1, mode: 3, ps: limit });

    const replies = Array.isArray(data?.replies) ? data.replies : [];
    if (replies.length === 0) throw errors.empty(parent != null ? `No replies under comment ${parent}` : `No comments on ${bvid}`);
    return replies.slice(0, limit).map(formatReplyRow);
  },
});
