import { defineAdapter } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnBili, biliGet, getSelfUid, resolveUid } from './_shared.js';

export default defineAdapter({
  description: 'List who a Bilibili user follows (defaults to yourself; accepts a uid or username).',
  access: 'read',
  domain: 'bilibili.com',
  args: [
    { name: 'uid', type: 'string', help: 'Target user uid or username (defaults to the logged-in user)' },
    { name: 'page', type: 'int', default: 1, help: 'Page number' },
    { name: 'limit', type: 'int', default: 50, help: 'How many per page (max 50)' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const uid = args.uid ? await resolveUid(tab, args.uid) : await getSelfUid(tab);
    const pn = Number(args.page) || 1;
    const ps = Math.min(Number(args.limit) || 50, 50);
    const data = await biliGet(tab, `https://api.bilibili.com/x/relation/followings?vmid=${uid}&pn=${pn}&ps=${ps}&order=desc`);
    const list = data?.list || [];
    return list.map((u) => ({
      mid: u.mid,
      name: u.uname,
      sign: (u.sign || '').slice(0, 40),
      relation: u.attribute === 6 ? 'mutual' : 'following',
      verified: u.official_verify?.desc || '',
      url: `https://space.bilibili.com/${u.mid}`,
    }));
  },
});
