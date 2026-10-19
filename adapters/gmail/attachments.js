import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { accountNumber, gmailFetchThread } from './_shared.js';

export default defineAdapter({
  description: 'List attachment metadata for a Gmail thread through the fetch-data JSON API.',
  access: 'read', domain: 'mail.google.com',
  result: { kind: 'rows', description: 'Attachment metadata' },
  args: [
    { name: 'thread', type: 'string', required: true, help: 'thread-f ID from search, legacy hex ID, or Gmail URL' },
    { name: 'account', type: 'int', default: 0, min: 0, max: 20 },
  ],
  async run({ tab, args }) {
    if (!args.thread) throw errors.argument('thread is required');
    const messages = await gmailFetchThread(tab, args.thread, accountNumber(args.account));
    return { rows: messages.flatMap((message) => message.attachments.map((attachment) => ({ messageId: message.messageId, ...attachment }))) };
  },
});
