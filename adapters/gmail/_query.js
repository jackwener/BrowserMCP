import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { accountNumber, gmailBatchView, parseBatchView } from './_shared.js';

export function fixedQueryAdapter(name, query) {
  return defineAdapter({
    description: `List Gmail ${name} threads through the batch-view JSON API.`,
    access: 'read', domain: 'mail.google.com',
    result: { kind: 'rows', description: `${name} threads` },
    args: [
      { name: 'limit', type: 'int', default: 20, min: 1, max: 50, help: 'Maximum threads from the first API page' },
      { name: 'account', type: 'int', default: 0, min: 0, max: 20, help: 'Gmail account index' },
    ],
    async run({ tab, args }) {
      const limit = Number(args.limit ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw errors.argument('limit must be between 1 and 50');
      return { rows: parseBatchView(await gmailBatchView(tab, query, accountNumber(args.account))).slice(0, limit) };
    },
  });
}
