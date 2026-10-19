import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { rest } from './_shared.js';

export default defineAdapter({
  description: 'Mute a keyword/phrase so tweets containing it are hidden.',
  access: 'write',
  domain: 'x.com',
  args: [{ name: 'keyword', type: 'string', required: true, help: 'The word or phrase to mute' }],
  async run({ tab, args }) {
    const keyword = String(args.keyword ?? '').trim();
    if (!keyword) throw errors.argument('keyword is required');
    await rest(tab, 'mutes/keywords/create.json', { keyword, mute_surfaces: 'notifications,home_timeline,tweet_replies', mute_option: '', duration: '' });
    return { ok: true, keyword, muted: true };
  },
});
