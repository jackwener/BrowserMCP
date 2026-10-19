import { defineAdapter } from 'browsermcp/adapter-sdk';
import { discordClient } from './_shared.js';

export default defineAdapter({
  description: 'Check the signed-in Discord account through the users API.',
  access: 'read', domain: 'discord.com',
  result: { kind: 'value', description: 'Discord account status' },
  async run({ tab }) {
    const { api, route } = await discordClient(tab);
    const user = await api('/users/@me');
    return { connected: true, user_id: user.id, username: user.username, display_name: user.global_name || user.username, current_guild: route?.guild || null, current_channel: route?.channel || null };
  },
});
