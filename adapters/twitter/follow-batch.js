import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnX, rest, resolveUserId, normalizeScreenName } from './_shared.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default defineAdapter({
  description: 'Follow several users in one call.',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'usernames', type: 'string', required: true, help: 'Screen names, comma- or space-separated' },
    { name: 'delay_ms', type: 'int', default: 1500, help: 'Pause between follows (ms) to avoid rate limits' },
  ],
  async run({ tab, args }) {
    await ensureOnX(tab);
    const names = String(args.usernames || '').split(/[\s,]+/).map(normalizeScreenName).filter(Boolean);
    if (!names.length) throw errors.argument('usernames is required (comma- or space-separated)');
    const delay = Math.max(0, Number(args.delay_ms) || 0);
    const rows = [];
    for (let i = 0; i < names.length; i++) {
      const screen = names[i];
      try { const userId = await resolveUserId(tab, screen); await rest(tab, 'friendships/create.json', { user_id: userId }); rows.push({ username: screen, status: 'success' }); }
      catch (e) { rows.push({ username: screen, status: 'error', error: e?.message || String(e) }); }
      if (delay && i < names.length - 1) await sleep(delay);
    }
    return { rows };
  },
});
