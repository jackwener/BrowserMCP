import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnX, authHeaders } from './_shared.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

export default defineAdapter({
  description: 'Send a message to your recent DM conversations (via the DM API, not the UI).',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'text', type: 'string', required: true, help: 'Message text to send' },
    { name: 'max', type: 'int', default: 20, help: 'Max conversations to message' },
    { name: 'skip_replied', type: 'boolean', default: true, help: 'Skip conversations whose last message is already this text from you' },
  ],
  async run({ tab, args }) {
    const text = String(args.text ?? '');
    if (!text.trim()) throw errors.argument('text is required');
    await ensureOnX(tab);
    const headers = await authHeaders(tab);
    // who am I
    const me = await tab.fetchJson('/i/api/1.1/account/verify_credentials.json', { headers });
    const selfId = String(me?.id_str || me?.id || '');
    // recent conversations
    const inbox = await tab.fetchJson('/i/api/1.1/dm/inbox_initial_state.json?nsfw_filtering_enabled=false&filter_low_quality=false&include_quality=all', { headers });
    const state = inbox?.inbox_initial_state || {};
    const conversations = state.conversations || {};
    const entries = state.entries || [];
    // last message text per conversation
    const lastByConv = {};
    for (const e of entries) { const m = e.message?.message_data; const cid = e.message?.conversation_id; if (m && cid && !(cid in lastByConv)) lastByConv[cid] = { text: m.text, sender: String(m.sender_id || '') }; }
    const max = Math.max(1, Number(args.max) || 20);
    const rows = [];
    const cids = Object.keys(conversations).slice(0, max);
    for (let i = 0; i < cids.length; i++) {
      const cid = cids[i];
      const last = lastByConv[cid];
      if (args.skip_replied && last && last.sender === selfId && last.text === text) { rows.push({ conversation_id: cid, status: 'skipped', reason: 'already sent' }); continue; }
      try {
        const body = { conversation_id: cid, recipient_ids: false, request_id: uuid(), text, cards_platform: 'Web-12', include_cards: 1, include_quote_count: true, dm_users: false };
        await tab.fetchJson('/i/api/1.1/dm/new2.json', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
        rows.push({ conversation_id: cid, status: 'sent' });
      } catch (e) { rows.push({ conversation_id: cid, status: 'error', error: e?.message || String(e) }); }
      if (i < cids.length - 1) await sleep(1000);
    }
    if (!rows.length) throw errors.empty('No DM conversations found');
    return { rows };
  },
});
