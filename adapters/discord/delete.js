import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { channelId, discordClient } from './_shared.js';

export default defineAdapter({
  description: 'Delete one of your Discord messages through the channel messages API.',
  access: 'write', domain: 'discord.com',
  result: { kind: 'value', description: 'Deleted message ID' },
  args: [
    { name: 'message_id', type: 'string', required: true, help: 'Discord message ID' },
    { name: 'guild', type: 'string', help: 'Server ID or name' },
    { name: 'channel', type: 'string', help: 'Channel ID or name; defaults to current channel' },
    { name: 'url', type: 'string', help: 'Discord channel URL' },
  ],
  async run({ tab, args }) {
    const id = String(args.message_id || '');
    if (!/^\d{17,20}$/.test(id)) throw errors.argument('message_id must be a Discord message ID');
    const { api, route } = await discordClient(tab);
    const { channel } = await channelId(api, args, route);
    await api(`/channels/${channel}/messages/${id}`, { method: 'DELETE' });
    return { deleted: true, message_id: id, channel_id: channel };
  },
});
