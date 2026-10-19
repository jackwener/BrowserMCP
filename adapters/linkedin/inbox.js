import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { compact, csrf, integer } from './_shared.js';

async function queryFromScriptTraffic(tab) {
  return tab.evaluate(`(async () => {
    const html = await (await fetch('/messaging/', { credentials: 'include' })).text();
    const urls = html.split('<script src="').slice(1).map((part) => part.split('"')[0])
      .filter((url) => url.startsWith('https://static.licdn.com/'));
    const results = await Promise.all(urls.slice(0, 80).map(async (url) => {
      try {
        const source = await (await fetch(url)).text();
        const operation = source.indexOf('name:"find-conversations-by-category-v2"');
        if (operation < 0) return null;
        const prefix = source.slice(Math.max(0, operation - 250), operation);
        const start = prefix.lastIndexOf('messengerConversations.');
        if (start < 0) return null;
        const id = prefix.slice(start, start + 55);
        const hash = id.slice('messengerConversations.'.length);
        return hash.length === 32 && Array.from(hash).every((char) => '0123456789abcdef'.includes(char)) ? id : null;
      } catch { return null; }
    }));
    return results.find(Boolean) || null;
  })()`);
}

export function mapConversations(json, mailboxUrn = '') {
  const collection = json?.data?.messengerConversationsByCategoryQuery;
  if (!Array.isArray(collection?.elements)) throw errors.upstream('LinkedIn messaging API returned no conversation elements');
  const rows = collection.elements.map((conversation) => {
    const threadId = String(conversation.backendUrn || '').replace(/^urn:li:messagingThread:/, '');
    if (!threadId) throw errors.upstream('LinkedIn conversation has no stable thread ID');
    const participants = (conversation.conversationParticipants || [])
      .filter((item) => item && (!mailboxUrn || item.hostIdentityUrn !== mailboxUrn));
    const names = participants.map((item) => {
      const type = item.participantType || {};
      if (type.organization) return compact(type.organization.name?.text);
      if (type.member) return compact(`${type.member.firstName?.text || ''} ${type.member.lastName?.text || ''}`);
      return compact(type.agent?.name?.text);
    }).filter(Boolean);
    const firstType = participants[0]?.participantType || {};
    const lastMessage = conversation.messages?.elements?.[0];
    const ms = Number(conversation.lastActivityAt || 0);
    return {
      thread_id: threadId,
      thread_url: `https://www.linkedin.com/messaging/thread/${encodeURIComponent(threadId)}/`,
      person_name: compact(conversation.title) || names.join(', '),
      last_message_preview: compact(lastMessage?.body?.text || conversation.descriptionText).slice(0, 300),
      unread: Number(conversation.unreadCount || 0) > 0 || conversation.read === false,
      counterparty_type: firstType.organization ? 'organization' : firstType.member ? 'member' : firstType.agent ? 'agent' : '',
      category: Array.isArray(conversation.categories) ? conversation.categories.join(',') : '',
      timestamp: ms > 0 && Number.isFinite(ms) ? new Date(ms).toISOString() : null,
      _sort: ms,
    };
  });
  rows.sort((a, b) => b._sort - a._sort);
  return { rows: rows.map(({ _sort, ...row }) => row), nextCursor: collection.metadata?.nextCursor || null };
}

export default defineAdapter({
  description: 'List LinkedIn messaging conversations through the messenger GraphQL API.',
  access: 'read', domain: 'linkedin.com',
  result: { kind: 'rows', description: 'Messaging conversations', paginated: true },
  args: [
    { name: 'limit', type: 'int', default: 20, min: 1, max: 100 },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous page' },
    { name: 'unread_only', type: 'boolean', default: false },
  ],
  async run({ tab, args }) {
    const limit = integer(args.limit, 'limit', 20, 1, 100);
    await tab.goto('https://www.linkedin.com/messaging/', { waitUntil: 'load' });
    let urls = [];
    for (let attempt = 0; attempt < 20 && !urls.length; attempt++) {
      urls = await tab.evaluate(`performance.getEntriesByType('resource').map((item) => item.name).filter((name) => name.includes('/voyager/api/voyagerMessagingGraphQL/graphql?') && name.includes('queryId=messengerConversations.'))`);
      if (!urls.length) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const template = urls.find((url) => url.includes('conversationCategoryPredicate')) || urls[0];
    if (!template) throw errors.upstream('LinkedIn did not issue a messenger conversations request');
    const parsed = new URL(template);
    if (parsed.origin !== 'https://www.linkedin.com' || parsed.pathname !== '/voyager/api/voyagerMessagingGraphQL/graphql') {
      throw errors.upstream('LinkedIn messaging API URL was unexpected');
    }
    const mailbox = parsed.searchParams.get('variables')?.match(/mailboxUrn:(urn[^,)&]+)/)?.[1];
    if (!mailbox) throw errors.upstream('LinkedIn messaging API did not reveal mailbox identity');
    const mailboxUrn = decodeURIComponent(mailbox);
    const queryId = urls.find((url) => url.includes('conversationCategoryPredicate'))
      ? parsed.searchParams.get('queryId') : await queryFromScriptTraffic(tab);
    if (!queryId) throw errors.upstream('LinkedIn did not expose the current inbox GraphQL operation');
    const parts = ['query:(predicateUnions:List((conversationCategoryPredicate:(category:INBOX))))', `count:${limit}`, `mailboxUrn:${encodeURIComponent(mailboxUrn)}`];
    if (args.cursor) parts.push(`nextCursor:${encodeURIComponent(String(args.cursor))}`);
    const url = `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${queryId}&variables=(${parts.join(',')})`;
    const token = await csrf(tab);
    let json;
    try {
      json = await tab.fetchJson(url, { headers: { 'csrf-token': token,
        'x-restli-protocol-version': '2.0.0', accept: 'application/vnd.linkedin.normalized+json+2.1' } });
    } catch (cause) { throw errors.upstream(`LinkedIn messaging API request failed: ${String(cause?.message || cause)}`); }
    const result = mapConversations(json, mailboxUrn);
    const rows = args.unread_only ? result.rows.filter((row) => row.unread) : result.rows;
    return { rows: rows.slice(0, limit).map((row, index) => ({ rank: index + 1, ...row })),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
  },
});
