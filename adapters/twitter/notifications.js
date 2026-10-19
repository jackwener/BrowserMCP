import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnX, authHeaders } from './_shared.js';

function instructionsOf(data) {
  return data?.data?.viewer?.timeline_response?.timeline?.instructions
    || data?.data?.viewer_v2?.user_results?.result?.notification_timeline?.timeline?.instructions
    || data?.data?.timeline?.instructions
    || data?.data?.viewer?.notification_timeline?.timeline?.instructions
    || [];
}

function parse(data, seen, rows) {
  const instructions = instructionsOf(data);
  let addEntries = instructions.find((i) => i.type === 'TimelineAddEntries') || instructions.find((i) => Array.isArray(i.entries));
  if (!addEntries) return;
  const push = (itemContent, entryId) => {
    if (!itemContent) return;
    const item = itemContent.notification_results?.result || itemContent.tweet_results?.result || itemContent;
    let action = 'Notification';
    let author = '';
    let text = '';
    let url = '';
    if (item.__typename === 'TimelineNotification') {
      text = item.rich_message?.text || item.message?.text || '';
      const from = item.template?.from_users?.[0]?.user_results?.result;
      author = from?.core?.screen_name || from?.legacy?.screen_name || '';
      url = item.notification_url?.url || '';
      action = item.notification_icon || 'Activity';
      const target = item.template?.target_objects?.[0]?.tweet_results?.result;
      if (target) {
        const tt = target.note_tweet?.note_tweet_results?.result?.text || target.legacy?.full_text || '';
        text += text && tt ? ' | ' + tt : tt;
        if (!url) url = `https://x.com/i/status/${target.rest_id}`;
      }
    } else if (item.__typename === 'TweetNotification') {
      const tweet = item.tweet_result?.result;
      author = tweet?.core?.user_results?.result?.core?.screen_name || tweet?.core?.user_results?.result?.legacy?.screen_name || '';
      text = tweet?.note_tweet?.note_tweet_results?.result?.text || tweet?.legacy?.full_text || item.message?.text || '';
      action = 'Mention/Reply';
      url = `https://x.com/i/status/${tweet?.rest_id}`;
    } else if (item.__typename === 'Tweet') {
      author = item.core?.user_results?.result?.core?.screen_name || item.core?.user_results?.result?.legacy?.screen_name || '';
      text = item.note_tweet?.note_tweet_results?.result?.text || item.legacy?.full_text || '';
      action = 'Mention';
      url = `https://x.com/i/status/${item.rest_id}`;
    }
    const id = item.id || item.rest_id || entryId;
    if (seen.has(id)) return;
    seen.add(id);
    rows.push({ id, action, author, text, url: url || 'https://x.com/notifications' });
  };
  for (const entry of addEntries.entries || []) {
    if (!String(entry.entryId || '').startsWith('notification-')) {
      for (const sub of entry.content?.items || []) push(sub.item?.itemContent, sub.entryId);
      continue;
    }
    push(entry.content?.itemContent, entry.entryId);
  }
}

export default defineAdapter({
  description: "Your X notifications (likes/replies/follows/mentions feed), newest first.",
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'limit', type: 'int', default: 20, help: 'How many notifications to return' },
  ],
  async run({ tab, args }) {
    const limit = Math.max(1, Number(args.limit) || 20);
    await ensureOnX(tab);
    await tab.network.start('NotificationsTimeline').catch(() => {});
    await tab.goto('https://x.com/notifications', { waitUntil: 'load', settleMs: 4000 });
    let url = null;
    for (let i = 0; i < 4 && !url; i++) {
      const cap = await tab.network.read({ pattern: 'NotificationsTimeline' }).catch(() => ({ entries: [] }));
      const hit = (cap.entries || []).map((e) => String(e.url || e.name || '')).find((u) => u.includes('/NotificationsTimeline'));
      if (hit) { url = hit; break; }
      await tab.act({ action: 'scroll', direction: 'down', amount: 1500 }).catch(() => {});
      await tab.evaluate('new Promise(r=>setTimeout(r,1500))').catch(() => {});
    }
    if (!url) throw errors.empty('Could not capture the notifications timeline request');
    const headers = await authHeaders(tab);
    const seen = new Set();
    const rows = [];
    const data = await tab.fetchJson(url, { headers });
    parse(data, seen, rows);
    if (!rows.length) throw errors.empty('No notifications found');
    return rows.slice(0, limit);
  },
});
