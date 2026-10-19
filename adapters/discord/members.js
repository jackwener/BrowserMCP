import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { count, discordClient, guildId } from './_shared.js';

export default defineAdapter({
  description: 'Search Discord server members through the members search API.',
  access: 'read', domain: 'discord.com',
  result: { kind: 'rows', description: 'Matching members' },
  args: [
    { name: 'guild', type: 'string', help: 'Server ID or name; defaults to current server' },
    { name: 'query', type: 'string', required: true, help: 'Username prefix' },
    { name: 'limit', type: 'int', default: 20, min: 1, max: 100 },
  ],
  async run({ tab, args }) {
    const query = String(args.query || '').trim();
    if (!query) throw errors.argument('query is required');
    const { api, route } = await discordClient(tab);
    const guild = await guildId(api, args.guild, route);
    const members = await api(`/guilds/${guild}/members/search?query=${encodeURIComponent(query)}&limit=${count(args.limit, 'limit', 20)}`);
    if (!Array.isArray(members)) throw errors.upstream('Discord member search API changed shape');
    return { rows: members.map((member) => ({
      id: member.user?.id || null,
      name: member.nick || member.user?.global_name || member.user?.username || null,
      username: member.user?.username || null,
      joined_at: member.joined_at || null,
      roles: member.roles || [],
    })) };
  },
});
