import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnX, fetchManagedLists } from './_shared.js';

export default defineAdapter({
  description: 'Your X lists (owned + subscribed). Returns id, name, member/follower counts, and public/private mode.',
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'limit', type: 'int', default: 50, help: 'How many lists to return' },
  ],
  async run({ tab, args }) {
    await ensureOnX(tab);
    const limit = Math.max(1, Number(args.limit) || 50);
    const lists = await fetchManagedLists(tab);
    if (!lists.length) throw errors.empty('No owned or subscribed lists found');
    return lists.slice(0, limit);
  },
});
