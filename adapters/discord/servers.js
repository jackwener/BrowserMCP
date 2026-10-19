import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { discordClient } from './_shared.js';

export default defineAdapter({
  description: 'List Discord servers through the authenticated guilds API.',
  access: 'read', domain: 'discord.com',
  result: { kind: 'rows', description: 'Servers' },
  async run({ tab }) {
    const { api } = await discordClient(tab);
    const guilds = await api('/users/@me/guilds');
    if (!Array.isArray(guilds)) throw errors.upstream('Discord guild list changed shape');
    return { rows: guilds.map((guild) => ({ id: guild.id, name: guild.name, owner: Boolean(guild.owner), url: `https://discord.com/channels/${guild.id}` })) };
  },
});
