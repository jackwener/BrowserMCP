import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { parsePostRows, searchPostsApi } from './_shared.js';

export default defineAdapter({
  description: 'Search Facebook posts through its logged-in streaming GraphQL API.',
  access: 'read', domain: 'facebook.com',
  result: { kind: 'rows', description: 'Matching posts', paginated: true },
  args: [
    { name: 'query', type: 'string', required: true, help: 'Post keywords' },
    { name: 'limit', type: 'int', default: 10, min: 1, max: 20, help: 'Requested API page size; Facebook may return additional posts' },
    { name: 'cursor', type: 'string', maxLength: 10000, help: 'nextCursor from a previous call' },
  ],
  async run({ tab, args }) {
    const limit = Number(args.limit ?? 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw errors.argument('limit must be between 1 and 20');
    const result = parsePostRows(await searchPostsApi(tab, args.query, limit, args.cursor || null));
    return { rows: result.rows, ...(result.pageInfo?.has_next_page && result.pageInfo.end_cursor ? { nextCursor: result.pageInfo.end_cursor } : {}) };
  },
});
