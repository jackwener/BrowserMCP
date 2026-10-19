import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { channelId, count, discordClient, messageRow } from './_shared.js';

export default defineAdapter({
  description: 'Read recent Discord messages from a channel through the messages API.',
  access: 'read', domain: 'discord.com',
  result: { kind: 'rows', description: 'Messages', paginated: true },
  args: [
    { name: 'guild', type: 'string', help: 'Server ID or name' },
    { name: 'channel', type: 'string', help: 'Channel ID or name; defaults to current channel' },
    { name: 'url', type: 'string', help: 'Discord channel URL' },
    { name: 'limit', type: 'int', default: 20, min: 1, max: 100 },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous page' },
  ],
  async run({ tab, args }) {
    const { api, route } = await discordClient(tab);
    const { channel } = await channelId(api, args, route);
    const limit = count(args.limit, 'limit', 20);
    if (args.cursor && !/^\d{17,20}$/.test(String(args.cursor))) throw errors.argument('cursor must be a Discord message ID');
    const messages = await api(`/channels/${channel}/messages?limit=${limit}${args.cursor ? `&before=${args.cursor}` : ''}`);
    if (!Array.isArray(messages)) throw errors.upstream('Discord messages API changed shape');
    return { rows: messages.map(messageRow), ...(messages.length === limit ? { nextCursor: messages.at(-1)?.id } : {}) };
  },
});
