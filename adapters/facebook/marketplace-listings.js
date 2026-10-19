import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureMarketplace, marketplaceQuery, textOf } from './_marketplace.js';

const ACTIVE = ['MarketplaceYouSellingFastActiveSectionPaginationQuery', '8133580450085625', 'marketplace_listing_sets'];
const INACTIVE = ['MarketplaceYouSellingFastInactiveSectionPaginationQuery', '8151900814925516', 'inactive_listing_sets'];

export function mapListingEdges(response, collection, status) {
  const connection = response?.data?.viewer?.[collection];
  const edges = connection?.edges;
  if (!Array.isArray(edges)) throw errors.upstream('Facebook Marketplace listings response changed shape');
  const rows = edges.flatMap(({ node }) => {
    const listing = node?.marketplace_listing || node?.listing || node;
    if (!listing || typeof listing !== 'object') return [];
    const id = textOf(listing.id || listing.listing_id || node?.id);
    const title = textOf(listing.marketplace_listing_title || listing.title || listing.name);
    const price = textOf(listing.listing_price || listing.price || listing.formatted_price);
    return [{ index: 0, id: id || null, title, price,
      status: textOf(listing.status || listing.listing_status) || status,
      listed: textOf(listing.creation_time || listing.created_time || listing.listed_at),
      clicks: textOf(listing.insights?.clicks || listing.click_count),
      actions: '', raw: listing }];
  });
  return { rows, pageInfo: connection.page_info };
}

export function listingsCursor(value) {
  if (!value) return { active: null, inactive: null, activeDone: false, inactiveDone: false };
  let parsed;
  try { parsed = JSON.parse(String(value)); } catch { throw errors.argument('cursor is invalid'); }
  if (!parsed || typeof parsed !== 'object' || ['active', 'inactive'].some((type) =>
    (parsed[type] !== null && typeof parsed[type] !== 'string') || typeof parsed[`${type}Done`] !== 'boolean')) {
    throw errors.argument('cursor is invalid');
  }
  return parsed;
}

export default defineAdapter({
  description: 'List your Facebook Marketplace active and inactive seller listings through GraphQL.',
  access: 'read', domain: 'facebook.com',
  result: { kind: 'rows', description: 'Marketplace seller listings' },
  args: [
    { name: 'limit', type: 'int', default: 20, min: 1, max: 100 },
    { name: 'cursor', type: 'string', help: 'Pagination cursor from a previous result' },
  ],
  async run({ tab, args }) {
    const limit = Number(args.limit ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw errors.argument('limit must be 1–100');
    const cursors = listingsCursor(args.cursor);
    await ensureMarketplace(tab, 'you/selling/');
    const rows = [];
    const next = { ...cursors };
    for (const [index, [operation, docId, collection]] of [ACTIVE, INACTIVE].entries()) {
      const type = index === 0 ? 'active' : 'inactive';
      if (cursors[`${type}Done`]) continue;
      const count = !cursors.activeDone && !cursors.inactiveDone
        ? (index === 0 ? Math.ceil(limit / 2) : Math.floor(limit / 2)) : limit;
      if (!count) continue;
      const response = await marketplaceQuery(tab, operation, docId,
        { count, cursor: cursors[type], scale: 1 });
      const mapped = mapListingEdges(response, collection, index === 0 ? 'Active' : 'Inactive');
      rows.push(...mapped.rows);
      next[type] = mapped.pageInfo?.has_next_page && mapped.pageInfo?.end_cursor ? mapped.pageInfo.end_cursor : null;
      next[`${type}Done`] = !next[type];
    }
    return { rows: rows.slice(0, limit).map((row, index) => ({ ...row, index: index + 1 })),
      ...(!next.activeDone || !next.inactiveDone ? { nextCursor: JSON.stringify(next) } : {}) };
  },
});
