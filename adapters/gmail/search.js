import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { accountNumber, gmailBatchView, parseBatchView } from './_shared.js';

export default defineAdapter({
  description: 'Search Gmail threads through Gmail’s batch-view JSON API.',
  access: 'read', domain: 'mail.google.com',
  result: { kind: 'rows', description: 'Matching threads' },
  args: [
    { name: 'query', type: 'string', required: true, help: 'Gmail search syntax, such as from:example.com is:unread' },
    { name: 'limit', type: 'int', default: 20, min: 1, max: 50, help: 'Maximum threads from the first API page' },
    { name: 'account', type: 'int', default: 0, min: 0, max: 20, help: 'Gmail account index' },
  ],
  async run({ tab, args }) {
    const query = String(args.query || '').trim();
    if (!query) throw errors.argument('query is required');
    const limit = Number(args.limit ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw errors.argument('limit must be between 1 and 50');
    const rows = parseBatchView(await gmailBatchView(tab, query, accountNumber(args.account)));
    return { rows: rows.slice(0, limit) };
  },
});
