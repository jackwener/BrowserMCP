import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { channelId, discordClient, messageRow } from './_shared.js';

export default defineAdapter({
  description: 'Send a Discord message through the channel messages API.',
  access: 'write', domain: 'discord.com',
  result: { kind: 'value', description: 'Created message' },
  args: [
    { name: 'text', type: 'string', required: true, maxLength: 2000, help: 'Message content' },
    { name: 'guild', type: 'string', help: 'Server ID or name' },
    { name: 'channel', type: 'string', help: 'Channel ID or name; defaults to current channel' },
    { name: 'url', type: 'string', help: 'Discord channel URL' },
  ],
  async run({ tab, args }) {
    const text = String(args.text || '');
    if (!text.trim() || text.length > 2000) throw errors.argument('text must contain 1–2000 characters');
    const { api, route } = await discordClient(tab);
    const { channel } = await channelId(api, args, route);
    const message = await api(`/channels/${channel}/messages`, { method: 'POST', body: { content: text, tts: false, nonce: String(Date.now()) } });
    return messageRow(message);
  },
});
