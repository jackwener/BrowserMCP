import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { channelId, channelUrl, discordClient, discordRoute } from './_shared.js';

export default defineAdapter({
  description: 'Open a Discord channel by ID, name, or URL.',
  access: 'read', domain: 'discord.com',
  result: { kind: 'value', description: 'Opened Discord route' },
  args: [
    { name: 'guild', type: 'string', help: 'Server ID or name' },
    { name: 'channel', type: 'string', help: 'Channel ID or name' },
    { name: 'url', type: 'string', help: 'Discord channel URL' },
  ],
  async run({ tab, args }) {
    if (!args.channel && !args.url) throw errors.argument('channel or url is required');
    const { api, route } = await discordClient(tab);
    const { channel, guild } = await channelId(api, args, route);
    const url = channelUrl(guild || '@me', channel);
    const opened = await tab.goto(url, { waitUntil: 'load' });
    const actual = discordRoute(opened.url || await tab.url());
    if (actual?.channel !== channel) throw errors.upstream('Discord did not open the requested channel');
    return { guild_id: actual.guild, channel_id: actual.channel, url };
  },
});
