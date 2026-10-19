import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnX, resolveLoggedInUser, normalizeScreenName } from './_shared.js';

const EXTRACT = `(() => {
  const out = [];
  for (const cell of document.querySelectorAll('[data-testid="UserCell"]')) {
    const strip = new Set();
    for (const el of cell.querySelectorAll('[data-testid$="-follow"],[data-testid$="-unfollow"],[data-testid="userFollowIndicator"]')) {
      const t = (el.innerText || '').trim(); if (t) strip.add(t);
    }
    const lines = (cell.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean).filter(l => !strip.has(l));
    let screen_name = '';
    const remaining = [];
    for (const l of lines) { if (!screen_name && l.startsWith('@')) screen_name = l.slice(1).split(/\\s/)[0]; else remaining.push(l); }
    if (!screen_name) {
      const av = cell.querySelector('[data-testid^="UserAvatar-Container-"]');
      const tid = av ? av.getAttribute('data-testid') || '' : '';
      if (tid.startsWith('UserAvatar-Container-')) screen_name = tid.slice('UserAvatar-Container-'.length);
    }
    const name = remaining[0] || screen_name;
    const bio = remaining.slice(1).join(' ').replace(/\\s+/g, ' ').trim();
    if (screen_name) out.push({ screen_name, name, bio });
  }
  return out;
})()`;

export default defineAdapter({
  description: 'Accounts following an X user (defaults to the logged-in user). Follower counts are not exposed in this list view; use the `profile` command for counts.',
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'user', type: 'string', help: 'Screen name (with or without @). Omit for the logged-in user.' },
    { name: 'limit', type: 'int', default: 50, help: 'How many followers to return' },
  ],
  async run({ tab, args }) {
    await ensureOnX(tab);
    const raw = String(args.user || '').trim();
    let user = raw ? normalizeScreenName(raw) : '';
    if (raw && !user) throw errors.argument('user must be a valid X handle', 'Example: { user: "elonmusk" }');
    if (!user) user = await resolveLoggedInUser(tab);
    const limit = Math.max(1, Number(args.limit) || 50);
    await tab.goto(`https://x.com/${user}/followers`, { waitUntil: 'load', settleMs: 3000 });
    const rows = [];
    const seen = new Set();
    let stale = 0;
    while (rows.length < limit && stale < 4) {
      const batch = await tab.evaluate(EXTRACT);
      let added = 0;
      for (const f of Array.isArray(batch) ? batch : []) {
        if (!seen.has(f.screen_name) && rows.length < limit) { seen.add(f.screen_name); rows.push(f); added++; }
      }
      if (rows.length >= limit) break;
      stale = added ? 0 : stale + 1;
      await tab.act({ action: 'scroll', direction: 'down', amount: 1200 }).catch(() => {});
      await tab.evaluate('new Promise(r=>setTimeout(r,1200))').catch(() => {});
    }
    if (!rows.length) throw errors.empty(`No followers found for @${user}`);
    return rows.slice(0, limit);
  },
});
