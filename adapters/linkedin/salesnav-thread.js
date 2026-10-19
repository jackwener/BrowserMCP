import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { compact, ensureLinkedIn, integer, linkedinApi, requireElements } from './_shared.js';
import { DECORATION, inboxPath } from './salesnav-inbox.js';

function criterion(input) {
  const raw = compact(input);
  if (!raw) throw errors.argument('thread_or_recipient is required');
  if (/^2-[A-Za-z0-9+/=_-]+$/.test(raw)) return { kind: 'id', value: raw };
  if (/^urn:li:fs_salesProfile:\([^)]+\)$/.test(raw)) return { kind: 'urn', value: raw };
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname)) throw errors.argument('thread_or_recipient URL must be on LinkedIn');
    const thread = url.pathname.match(/^\/sales\/inbox\/([^/]+)\/?$/);
    if (thread) return { kind: 'id', value: decodeURIComponent(thread[1]) };
    const lead = url.pathname.match(/^\/sales\/lead\/([^,/]+),([^,/]+),([^/]+)\/?$/);
    if (lead) return { kind: 'urn', value: `urn:li:fs_salesProfile:(${lead.slice(1).map(decodeURIComponent).join(',')})` };
    throw errors.argument('thread_or_recipient must be an inbox URL, lead URL, thread ID, URN, or exact name');
  } catch (cause) { if (cause?.code) throw cause; }
  return { kind: 'name', value: raw.toLowerCase() };
}

export function threadPath(threadId, messageCount) {
  const decoration = encodeURIComponent(DECORATION).replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `/sales-api/salesApiMessagingThreads/${encodeURIComponent(threadId)}?decoration=${decoration}&count=1&messageCount=${messageCount}`;
}

function participants(thread) {
  const resolution = thread?.participantsResolutionResults || {};
  const urns = Array.isArray(thread?.participants) ? thread.participants : Object.keys(resolution);
  return urns.map((urn) => ({ urn, profile: resolution[urn] || { entityUrn: urn } }));
}

function matches(thread, parsed) {
  const people = participants(thread);
  if (parsed.kind === 'urn') return people.some(({ urn, profile }) => urn === parsed.value || profile.entityUrn === parsed.value);
  return people.some(({ profile }) => compact(profile.fullName || `${profile.firstName || ''} ${profile.lastName || ''}`).toLowerCase() === parsed.value);
}

async function resolveThread(tab, parsed, maxPages) {
  if (parsed.kind === 'id') return parsed.value;
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const elements = requireElements(await linkedinApi(tab, inboxPath(cursor, 20)), 'Sales Navigator inbox');
    const found = elements.find((thread) => matches(thread, parsed));
    if (found?.id) return String(found.id);
    const next = elements.at(-1)?.nextPageStartsAt;
    if (!next || next === cursor || !elements.length) break;
    cursor = String(next);
  }
  throw errors.empty('No Sales Navigator conversation matched the recipient');
}

export function mapThreadMessages(thread) {
  const threadId = compact(thread?.id);
  if (!threadId || !Array.isArray(thread?.messages)) throw errors.upstream('Sales Navigator thread API returned malformed messages');
  const byUrn = new Map(participants(thread).map(({ urn, profile }) => [urn, profile]));
  const rows = thread.messages.flatMap((message) => {
    if (!message || typeof message !== 'object') throw errors.upstream('Sales Navigator thread API returned a malformed message');
    const ms = Number(message.deliveredAt || 0);
    const sender = byUrn.get(message.author);
    const row = {
      message_id: compact(message.id), thread_id: threadId,
      thread_url: `https://www.linkedin.com/sales/inbox/${encodeURIComponent(threadId)}`,
      sender: compact(sender?.fullName || `${sender?.firstName || ''} ${sender?.lastName || ''}`) || compact(message.author),
      sender_urn: compact(message.author), text: compact(message.body || message.systemMessageContent),
      subject: compact(message.subject),
      timestamp: ms > 0 && Number.isFinite(ms) ? new Date(ms).toISOString() : null,
      delivered_at: ms || null, type: compact(message.type),
      total_message_count: Number(thread.totalMessageCount || thread.messages.length),
    };
    return row.message_id || row.text || row.subject ? [row] : [];
  });
  rows.sort((a, b) => Number(a.delivered_at || 0) - Number(b.delivered_at || 0));
  return rows.map((row, index) => ({ index, ...row }));
}

export default defineAdapter({
  description: 'Read full Sales Navigator conversation history through the sales API. Requires Sales Navigator access.',
  access: 'read', domain: 'linkedin.com',
  result: { kind: 'rows', description: 'Sales Navigator messages' },
  args: [
    { name: 'thread_or_recipient', type: 'string', required: true },
    { name: 'limit', type: 'int', default: 200, min: 1, max: 500 },
    { name: 'max_pages', type: 'int', default: 30, min: 1, max: 100 },
  ],
  async run({ tab, args }) {
    const parsed = criterion(args.thread_or_recipient);
    const limit = integer(args.limit, 'limit', 200, 1, 500);
    const maxPages = integer(args.max_pages, 'max_pages', 30, 1, 100);
    await ensureLinkedIn(tab);
    const threadId = await resolveThread(tab, parsed, maxPages);
    let requested = Math.min(20, limit);
    let thread;
    for (let attempt = 0; attempt < 30; attempt++) {
      thread = await linkedinApi(tab, threadPath(threadId, requested));
      const have = Array.isArray(thread?.messages) ? thread.messages.length : 0;
      const total = Number(thread?.totalMessageCount || 0);
      if (have >= limit || (total && have >= total) || requested >= limit) break;
      requested = Math.min(limit, Math.max(requested + 20, total || 0));
    }
    const rows = mapThreadMessages(thread);
    const total = Number(thread?.totalMessageCount || 0);
    if (total && rows.length < Math.min(total, limit)) throw errors.upstream(`Sales Navigator returned partial thread history (${rows.length}/${total})`);
    return { rows: rows.slice(0, limit) };
  },
});
