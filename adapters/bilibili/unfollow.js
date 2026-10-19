import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnBili, biliPost, getSelfUid, resolveUid, parseSpaceMidUrl, fetchRelationAttribute, waitForRelation } from './_shared.js';

async function resolveTargetMid(tab, raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw errors.argument('Unfollow target cannot be empty');
  if (/^(?:https?:\/\/)?space\.bilibili\.com\//i.test(trimmed)) {
    const mid = parseSpaceMidUrl(trimmed);
    if (!mid) throw errors.argument('Target must be a valid space.bilibili.com/<uid> URL');
    return mid;
  }
  return resolveUid(tab, trimmed);
}

export default defineAdapter({
  description: 'Unfollow a Bilibili user. Accepts a uid, username, or space.bilibili.com profile URL (requires login).',
  access: 'write',
  domain: 'bilibili.com',
  args: [
    { name: 'target', type: 'string', required: true, help: 'Target uid, username, or space.bilibili.com URL' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const mid = await resolveTargetMid(tab, args.target);
    const self = await getSelfUid(tab);
    if (mid === self) throw errors.argument('Cannot unfollow yourself');
    const url = `https://space.bilibili.com/${mid}`;
    const attribute = await fetchRelationAttribute(tab, mid);
    // 2=following, 6=mutual; anything else means not currently following.
    if (attribute !== 2 && attribute !== 6) return { mid, status: 'not-following', url };
    await biliPost(tab, '/x/relation/modify', { fid: mid, act: 2, re_src: 11 });
    await waitForRelation(tab, mid, (a) => a !== 2 && a !== 6, 'not following');
    return { mid, status: 'unfollowed', url };
  },
});
