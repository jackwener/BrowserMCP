import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnBili, biliPost, getSelfUid, resolveUid, parseSpaceMidUrl, fetchRelationAttribute, waitForRelation } from './_shared.js';

async function resolveTargetMid(tab, raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw errors.argument('Follow target cannot be empty');
  if (/^(?:https?:\/\/)?space\.bilibili\.com\//i.test(trimmed)) {
    const mid = parseSpaceMidUrl(trimmed);
    if (!mid) throw errors.argument('Target must be a valid space.bilibili.com/<uid> URL');
    return mid;
  }
  return resolveUid(tab, trimmed);
}

export default defineAdapter({
  description: 'Follow a Bilibili user. Accepts a uid, username, or space.bilibili.com profile URL (requires login).',
  access: 'write',
  domain: 'bilibili.com',
  args: [
    { name: 'target', type: 'string', required: true, help: 'Target uid, username, or space.bilibili.com URL' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const mid = await resolveTargetMid(tab, args.target);
    const self = await getSelfUid(tab);
    if (mid === self) throw errors.argument('Cannot follow yourself');
    const url = `https://space.bilibili.com/${mid}`;
    const attribute = await fetchRelationAttribute(tab, mid);
    if (attribute === 2 || attribute === 6) return { mid, status: 'already-following', url };
    if (attribute === 128) throw errors.upstream(`User ${mid} is blocked; unblock first before following.`);
    // act=1 follow; re_src=11 is the standard web source value.
    await biliPost(tab, '/x/relation/modify', { fid: mid, act: 1, re_src: 11 });
    await waitForRelation(tab, mid, (a) => a === 2 || a === 6, 'following');
    return { mid, status: 'followed', url };
  },
});
