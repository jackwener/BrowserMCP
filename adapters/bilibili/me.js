import { defineAdapter } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnBili, biliApiSigned, getSelfUid } from './_shared.js';

export default defineAdapter({
  description: 'Your own Bilibili profile: name, level, coins, followers, following (requires login).',
  access: 'read',
  domain: 'bilibili.com',
  args: [],
  async run({ tab }) {
    await ensureOnBili(tab);
    const uid = await getSelfUid(tab);
    const data = await biliApiSigned(tab, '/x/space/wbi/acc/info', { mid: uid });
    return [{
      name: data.name ?? '',
      uid: data.mid ?? uid,
      level: data.level ?? 0,
      coins: data.coins ?? 0,
      followers: data.follower ?? 0,
      following: data.following ?? 0,
      sign: data.sign ?? '',
      url: `https://space.bilibili.com/${data.mid ?? uid}`,
    }];
  },
});
