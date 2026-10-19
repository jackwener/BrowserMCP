import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { channelUrl, discordClient, guildId } from './_shared.js';

export default defineAdapter({
  description: 'List Discord server channels or direct-message channels through the API.',
  access: 'read', domain: 'discord.com',
  result: { kind: 'rows', description: 'Channels' },
  args: [{ name: 'guild', type: 'string', help: 'Server ID or name; defaults to the current server' }],
  async run({ tab, args }) {
    const { api, route } = await discordClient(tab);
    const raw = String(args.guild || route?.guild || '').trim();
    if (raw === '@me') {
      const channels = await api('/users/@me/channels');
      if (!Array.isArray(channels)) throw errors.upstream('Discord direct-message channels changed shape');
      return { rows: channels.map((channel) => ({ id: channel.id, name: channel.recipients?.map((person) => person.global_name || person.username).join(', ') || channel.name || 'DM', type: channel.type, guild_id: null, url: channelUrl('@me', channel.id) })) };
    }
    const guild = await guildId(api, raw, route);
    const channels = await api(`/guilds/${guild}/channels`);
    if (!Array.isArray(channels)) throw errors.upstream('Discord channels API changed shape');
    return { rows: channels.map((channel) => ({ id: channel.id, name: channel.name, type: channel.type, parent_id: channel.parent_id || null, guild_id: guild, url: channelUrl(guild, channel.id) })) };
  },
});
