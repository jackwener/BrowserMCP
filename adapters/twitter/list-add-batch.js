import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnX } from './_shared.js';
import { runListAdd } from './list-add.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default defineAdapter({
  description: 'Add several users to a list you own.',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'list_id', type: 'string', required: true, help: 'Numeric ID of a list you own' },
    { name: 'usernames', type: 'string', required: true, help: 'Screen names, comma- or space-separated' },
    { name: 'interval', type: 'int', default: 1500, help: 'Pause between operations (ms)' },
  ],
  async run({ tab, args }) {
    await ensureOnX(tab);
    const listId = String(args.list_id || '').trim();
    const names = String(args.usernames || '').split(/[\s,]+/).map((s) => s.replace(/^@/, '').trim()).filter(Boolean);
    if (!names.length) throw errors.argument('usernames is required');
    const delay = Math.max(0, Number(args.interval) || 0);
    const rows = [];
    for (let i = 0; i < names.length; i++) {
      try { rows.push(await runListAdd(tab, listId, names[i])); }
      catch (e) { rows.push({ list_id: listId, username: names[i], status: 'error', error: e?.message || String(e) }); }
      if (delay && i < names.length - 1) await sleep(delay);
    }
    return { rows };
  },
});
