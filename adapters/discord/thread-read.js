import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { count, discordClient, discordRoute, messageRow } from './_shared.js';

export default defineAdapter({
  description: 'Read Discord thread messages through the messages API.',
  access: 'read', domain: 'discord.com',
  result: { kind: 'rows', description: 'Thread messages', paginated: true },
  args: [
    { name: 'thread', type: 'string', required: true, help: 'Thread ID or Discord thread URL' },
    { name: 'limit', type: 'int', default: 20, min: 1, max: 100 },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous page' },
  ],
  async run({ tab, args }) {
    const raw = String(args.thread || '');
    const parsed = discordRoute(raw);
    const thread = /^\d{17,20}$/.test(raw) ? raw : (parsed?.message || parsed?.channel);
    if (!thread) throw errors.argument('thread must be a Discord thread ID or URL');
    const limit = count(args.limit, 'limit', 20);
    if (args.cursor && !/^\d{17,20}$/.test(String(args.cursor))) throw errors.argument('cursor must be a Discord message ID');
    const { api } = await discordClient(tab);
    const messages = await api(`/channels/${thread}/messages?limit=${limit}${args.cursor ? `&before=${args.cursor}` : ''}`);
    if (!Array.isArray(messages)) throw errors.upstream('Discord thread messages changed shape');
    return { rows: messages.map(messageRow), ...(messages.length === limit ? { nextCursor: messages.at(-1)?.id } : {}) };
  },
});
