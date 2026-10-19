import { defineAdapter } from 'browsermcp/adapter-sdk';
import { accountNumber, gmailLabels } from './_shared.js';

export default defineAdapter({
  description: 'List Gmail system and user labels with counts through Gmail sync and bootstrap data.',
  access: 'read', domain: 'mail.google.com',
  result: { kind: 'rows', description: 'Gmail labels' },
  args: [{ name: 'account', type: 'int', default: 0, min: 0, max: 20, help: 'Gmail account index' }],
  async run({ tab, args }) { return { rows: await gmailLabels(tab, accountNumber(args.account)) }; },
});
