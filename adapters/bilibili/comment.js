import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnBili, biliApi, biliPost, resolveBvid, resolveUid } from './_shared.js';

export default defineAdapter({
  description: 'Post a comment or reply on a Bilibili video. Any @username in the message is resolved to a real mention. Accepts a BV id, URL, or b23.tv link.',
  access: 'write',
  domain: 'bilibili.com',
  args: [
    { name: 'bvid', type: 'string', required: true, help: 'BV id, video URL, or b23.tv short link' },
    { name: 'message', type: 'string', required: true, help: 'Comment text; @username in it is turned into a real mention' },
    { name: 'parent', type: 'int', help: 'Root rpid to reply under (omit for a top-level comment)' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const message = String(args.message ?? '').trim();
    if (!message) throw errors.argument('Comment message cannot be empty');
    const parent = args.parent != null ? Number(args.parent) : null;
    const bvid = await resolveBvid(args.bvid);

    const viewData = await biliApi(tab, '/x/web-interface/view', { bvid });
    const oid = viewData?.aid;
    if (!oid) throw errors.upstream(`Cannot resolve aid for bvid: ${bvid}`);

    // Resolve @username mentions → uids so they notify the mentioned user.
    const atNameToMid = {};
    for (const match of message.matchAll(/@([^\s@]+)/g)) {
      const name = match[1];
      if (name in atNameToMid) continue;
      try {
        const mid = Number(await resolveUid(tab, name));
        if (Number.isInteger(mid) && mid > 0) atNameToMid[name] = mid;
      } catch (err) {
        if (err?.code !== 'empty_result') throw err;
        // Unresolvable @name — leave it as plain text.
      }
    }

    const params = {
      oid, type: 1, message, plat: 1,
      ...(parent != null ? { root: parent, parent } : {}),
      ...(Object.keys(atNameToMid).length > 0 ? { at_name_to_mid: JSON.stringify(atNameToMid) } : {}),
    };
    const postData = await biliPost(tab, '/x/v2/reply/add', params);
    const rpid = postData?.rpid;
    if (!rpid) throw errors.upstream('Bilibili reply/add did not return an rpid');
    return {
      posted: true,
      rpid: String(rpid),
      bvid,
      oid: String(oid),
      message,
      url: `https://www.bilibili.com/video/${bvid}#reply${rpid}`,
    };
  },
});
