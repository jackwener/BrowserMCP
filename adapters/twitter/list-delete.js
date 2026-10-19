import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { mutate } from './_shared.js';

export default defineAdapter({
  description: 'Delete an X list you own.',
  access: 'write',
  domain: 'x.com',
  args: [{ name: 'list_id', type: 'string', required: true, help: 'Numeric ID of the list to delete' }],
  async run({ tab, args }) {
    const listId = String(args.list_id || '').trim();
    if (!/^\d+$/.test(listId)) throw errors.argument('list_id must be a numeric ID');
    await mutate(tab, 'DeleteList', { listId });
    return { ok: true, list_id: listId, deleted: true };
  },
});
