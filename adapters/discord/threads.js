import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { channelId, channelUrl, count, discordClient } from './_shared.js';

export default defineAdapter({
  description: 'List active and archived Discord forum threads through the API.',
  access: 'read', domain: 'discord.com',
  result: { kind: 'rows', description: 'Forum threads', paginated: true },
  args: [
    { name: 'guild', type: 'string', help: 'Server ID or name' },
    { name: 'channel', type: 'string', help: 'Forum channel ID or name; defaults to current channel' },
    { name: 'url', type: 'string', help: 'Discord forum channel URL' },
    { name: 'limit', type: 'int', default: 30, min: 1, max: 100 },
    { name: 'before', type: 'string', help: 'ISO timestamp cursor from a previous call' },
  ],
  async run({ tab, args }) {
    const { api, route } = await discordClient(tab);
    const { channel, guild } = await channelId(api, args, route);
    const limit = count(args.limit, 'limit', 30);
    const before = args.before ? `&before=${encodeURIComponent(String(args.before))}` : '';
    let active = [];
    if (!args.before && /^\d{17,20}$/.test(guild)) {
      try {
        const response = await api(`/guilds/${guild}/threads/active`);
        if (!Array.isArray(response?.threads)) throw errors.upstream('Discord active threads API changed shape');
        active = response.threads.filter((thread) => thread.parent_id === channel);
      } catch (cause) {
        if (!/denied access|HTTP 403/i.test(String(cause?.message || cause))) throw cause;
      }
    }
    const response = await api(`/channels/${channel}/threads/archived/public?limit=${limit}${before}`);
    if (!Array.isArray(response?.threads)) throw errors.upstream('Discord archived threads API changed shape');
    const rows = [...active, ...response.threads].map((thread) => ({
      thread_id: thread.id, channel_id: channel, guild_id: thread.guild_id || guild,
      name: thread.name, type: thread.type, message_count: thread.message_count,
      archived: Boolean(thread.thread_metadata?.archived),
      archive_timestamp: thread.thread_metadata?.archive_timestamp || null,
      url: channelUrl(thread.guild_id || guild, thread.id),
    }));
    const lastArchived = rows.filter((row) => row.archived).at(-1);
    return { rows, ...(response.has_more && lastArchived?.archive_timestamp ? { nextCursor: lastArchived.archive_timestamp } : {}) };
  },
});
