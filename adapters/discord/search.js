import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { channelId, count, discordClient, guildId, messageRow } from './_shared.js';

export default defineAdapter({
  description: 'Search Discord server messages through the guild search API.',
  access: 'read', domain: 'discord.com',
  result: { kind: 'rows', description: 'Matching messages', paginated: true },
  args: [
    { name: 'query', type: 'string', required: true, help: 'Text to search' },
    { name: 'guild', type: 'string', help: 'Server ID or name; defaults to current server' },
    { name: 'channel', type: 'string', help: 'Optional channel ID or name' },
    { name: 'offset', type: 'int', default: 0, min: 0, help: 'Result offset from a previous call' },
  ],
  async run({ tab, args }) {
    const query = String(args.query || '').trim();
    if (!query) throw errors.argument('query is required');
    const offset = args.offset === undefined ? 0 : Number(args.offset);
    if (!Number.isInteger(offset) || offset < 0) throw errors.argument('offset must be a non-negative integer');
    const { api, route } = await discordClient(tab);
    const guild = await guildId(api, args.guild, route);
    const channel = args.channel ? (await channelId(api, { guild, channel: args.channel }, route)).channel : null;
    const path = `/guilds/${guild}/messages/search?content=${encodeURIComponent(query)}&sort_by=timestamp&sort_order=desc&offset=${offset}${channel ? `&channel_id=${channel}` : ''}`;
    const result = await api(path);
    if (!Array.isArray(result?.messages)) throw errors.upstream('Discord search API changed shape');
    const rows = result.messages.flatMap((group) => Array.isArray(group) ? group : []).map(messageRow);
    return { rows, total: Number(result.total_results || 0), ...(offset + rows.length < Number(result.total_results || 0) && rows.length ? { nextCursor: offset + rows.length } : {}) };
  },
});
