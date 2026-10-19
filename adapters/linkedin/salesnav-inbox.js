import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { compact, ensureLinkedIn, integer, linkedinApi, requireElements } from './_shared.js';

export const DECORATION = '(id,restrictions,archived,unreadMessageCount,nextPageStartsAt,totalMessageCount,messages*(id,type,contentFlag,deliveredAt,lastEditedAt,subject,body,footerText,blockCopy,attachments,author,systemMessageContent),participants*~fs_salesProfile(entityUrn,firstName,lastName,fullName,degree,profilePictureDisplayImage,objectUrn,inmailRestriction))';

export function inboxPath(cursor = '', count = 20) {
  const decoration = encodeURIComponent(DECORATION).replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `/sales-api/salesApiMessagingThreads?decoration=${decoration}&count=${count}&filter=INBOX&q=filter${cursor ? `&pageStartsAt=${encodeURIComponent(cursor)}` : ''}`;
}

export function mapSalesThread(thread) {
  const id = compact(thread?.id);
  if (!id) throw errors.upstream('Sales Navigator conversation has no ID');
  const resolution = thread.participantsResolutionResults || {};
  const urns = Array.isArray(thread.participants) ? thread.participants : Object.keys(resolution);
  const participants = urns.map((urn) => resolution[urn] || { entityUrn: urn });
  const other = participants.find((person) => String(person.degree) !== '0') || participants[0] || {};
  const latest = Array.isArray(thread.messages) ? thread.messages[0] : null;
  const time = Number(latest?.deliveredAt || 0);
  return {
    thread_id: id,
    thread_url: `https://www.linkedin.com/sales/inbox/${encodeURIComponent(id)}`,
    person_name: compact(other.fullName || [other.firstName, other.lastName].filter(Boolean).join(' ')),
    last_message_snippet: compact(latest?.body || latest?.subject).slice(0, 300),
    last_activity_time: time > 0 ? new Date(time).toISOString() : null,
    unread: Number(thread.unreadMessageCount || 0) > 0,
    unread_count: Number(thread.unreadMessageCount || 0),
    total_message_count: Number(thread.totalMessageCount || 0),
    archived: Boolean(thread.archived),
    next_page_starts_at: compact(thread.nextPageStartsAt) || null,
  };
}

export default defineAdapter({
  description: 'List LinkedIn Sales Navigator conversations through its sales API. Requires Sales Navigator access.',
  access: 'read', domain: 'linkedin.com',
  result: { kind: 'rows', description: 'Sales Navigator conversations', paginated: true },
  args: [
    { name: 'limit', type: 'int', default: 20, min: 1, max: 100 },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous call' },
    { name: 'unread_only', type: 'boolean', default: false },
  ],
  async run({ tab, args }) {
    await ensureLinkedIn(tab);
    const limit = integer(args.limit, 'limit', 20, 1, 100);
    const cursor = compact(args.cursor);
    const elements = requireElements(await linkedinApi(tab, inboxPath(cursor, Math.min(20, limit))), 'Sales Navigator inbox');
    const rows = elements.map(mapSalesThread).filter((row) => !args.unread_only || row.unread).slice(0, limit);
    const next = elements.at(-1)?.nextPageStartsAt;
    return { rows, ...(next ? { nextCursor: String(next) } : {}) };
  },
});
