import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { rest, resolveUserId, normalizeScreenName } from './_shared.js';

export default defineAdapter({
  description: 'Unblock a user.',
  access: 'write',
  domain: 'x.com',
  args: [{ name: 'username', type: 'string', required: true, help: 'Screen name (with or without @)' }],
  async run({ tab, args }) {
    const screen = normalizeScreenName(args.username);
    if (!screen) throw errors.argument('username is required');
    const userId = await resolveUserId(tab, screen);
    await rest(tab, 'blocks/destroy.json', { user_id: userId });
    return { ok: true, username: screen, user_id: String(userId), blocked:false };
  },
});
