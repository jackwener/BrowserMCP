import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { parseProfileSearch, searchProfilesApi } from './_shared.js';

export default defineAdapter({
  description: 'Search Facebook people, groups, and pages through its logged-in GraphQL API.',
  access: 'read', domain: 'facebook.com',
  result: { kind: 'rows', description: 'Profiles with Facebook IDs and URLs', paginated: true },
  args: [
    { name: 'query', type: 'string', required: true, help: 'Name or keywords' },
    { name: 'type', type: 'string', default: 'people', choices: ['people', 'groups', 'pages'], help: 'Search category' },
    { name: 'limit', type: 'int', default: 10, min: 1, max: 20, help: 'Requested API page size; Facebook may return additional profiles' },
    { name: 'cursor', type: 'string', maxLength: 10000, help: 'nextCursor from a previous call' },
  ],
  async run({ tab, args }) {
    const limit = Number(args.limit ?? 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw errors.argument('limit must be between 1 and 20');
    const result = parseProfileSearch(await searchProfilesApi(tab, args.query, args.type || 'people', limit, args.cursor || null));
    return { rows: result.rows, ...(result.pageInfo?.has_next_page && result.pageInfo.end_cursor ? { nextCursor: result.pageInfo.end_cursor } : {}) };
  },
});
