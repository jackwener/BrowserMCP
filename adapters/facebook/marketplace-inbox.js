import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureMarketplace, marketplaceQuery, textOf } from './_marketplace.js';

const QUERIES = {
  buyer: ['CometMarketplaceInboxBuyerTabViewPaginationQuery', '6063301870422274', 'marketplaceInboxBuyerMessageThreads'],
  seller: ['CometMarketplaceInboxSellerTabThreadViewPaginationQuery', '25940357548956156', 'marketplaceInboxSellerMessageThreads'],
};

export function mapMarketplaceThreads(response, role = 'seller') {
  const connection = response?.data?.viewer?.[QUERIES[role]?.[2]];
  if (!Array.isArray(connection?.edges)) throw errors.upstream('Facebook Marketplace inbox response changed shape');
  const rows = connection.edges.flatMap(({ node }) => {
    if (!node || typeof node !== 'object') return [];
    const thread = node.thread || node;
    const buyer = textOf(thread.other_participant?.name || thread.buyer?.name || thread.participants?.[0]?.name);
    const listing = textOf(thread.marketplace_listing?.title || thread.listing?.title || thread.listing_title);
    const snippet = textOf(thread.last_message?.text || thread.snippet || thread.last_message_snippet);
    const time = textOf(thread.updated_time || thread.last_message?.timestamp);
    return [{ index: 0, id: textOf(thread.id) || null, role, buyer, listing, snippet, time,
      unread: Boolean(thread.unread_count || thread.is_unread), raw: thread }];
  });
  return { rows, pageInfo: connection.page_info };
}

export function inboxCursor(value) {
  if (!value) return { buyer: null, seller: null, buyerDone: false, sellerDone: false };
  let parsed;
  try { parsed = JSON.parse(String(value)); } catch { throw errors.argument('cursor is invalid'); }
  if (!parsed || typeof parsed !== 'object' || ['buyer', 'seller'].some((role) =>
    (parsed[role] !== null && typeof parsed[role] !== 'string') || typeof parsed[`${role}Done`] !== 'boolean')) {
    throw errors.argument('cursor is invalid');
  }
  return parsed;
}

export default defineAdapter({
  description: 'List Facebook Marketplace buyer and seller conversations through inbox GraphQL APIs.',
  access: 'read', domain: 'facebook.com',
  result: { kind: 'rows', description: 'Marketplace conversations' },
  args: [
    { name: 'limit', type: 'int', default: 20, min: 1, max: 100 },
    { name: 'role', type: 'string', default: 'both', help: 'buyer, seller, or both' },
    { name: 'cursor', type: 'string', help: 'Pagination cursor from a previous result' },
  ],
  async run({ tab, args }) {
    const limit = Number(args.limit ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw errors.argument('limit must be 1–100');
    const role = args.role || 'both';
    if (!['buyer', 'seller', 'both'].includes(role)) throw errors.argument('role must be buyer, seller, or both');
    const cursors = inboxCursor(args.cursor);
    await ensureMarketplace(tab, 'inbox/');
    const rows = [];
    const next = { ...cursors };
    for (const selected of role === 'both' ? ['buyer', 'seller'] : [role]) {
      if (cursors[`${selected}Done`]) continue;
      const [operation, docId] = QUERIES[selected];
      const count = role === 'both' && !cursors.buyerDone && !cursors.sellerDone
        ? (selected === 'buyer' ? Math.ceil(limit / 2) : Math.floor(limit / 2)) : limit;
      if (!count) continue;
      const response = await marketplaceQuery(tab, operation, docId,
        { count, cursor: cursors[selected], ...(selected === 'seller' ? { filterLabels: null, lookBackInDays: null } : {}) });
      const mapped = mapMarketplaceThreads(response, selected);
      rows.push(...mapped.rows);
      next[selected] = mapped.pageInfo?.has_next_page && mapped.pageInfo?.end_cursor ? mapped.pageInfo.end_cursor : null;
      next[`${selected}Done`] = !next[selected];
    }
    return { rows: rows.slice(0, limit).map((row, index) => ({ ...row, index: index + 1 })),
      ...((role === 'both' ? !next.buyerDone || !next.sellerDone : !next[`${role}Done`])
        ? { nextCursor: JSON.stringify(next) } : {}) };
  },
});
