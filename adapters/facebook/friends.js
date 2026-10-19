import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';

const PAGE = 'FriendingCometPYMKGridPaginationQuery';

export function mapFriendSuggestions(response) {
  if (response?.errors?.length) throw errors.upstream(`Facebook friend suggestions API: ${String(response.errors[0]?.message || 'GraphQL error')}`);
  const grid = response?.data?.viewer?.pymk_grid;
  if (!Array.isArray(grid?.edges)) throw errors.upstream('Facebook friend suggestions API response changed shape');
  const rows = grid.edges.flatMap(({ node }) => {
    const id = String(node?.id || '').trim();
    const name = String(node?.name || '').trim();
    if (!id || !name) return [];
    const context = String(node.social_context?.text || '').trim();
    const count = context.match(/([\d,]+)\s*(?:位)?(?:共同|mutual)/i)?.[1];
    return [{ id, name, url: `https://www.facebook.com/profile.php?id=${encodeURIComponent(id)}`,
      mutual_count: count ? Number(count.replaceAll(',', '')) : null,
      mutual_context: context || null,
      picture: typeof node.profile_picture?.uri === 'string' ? node.profile_picture.uri : null,
      friendship_status: String(node.friendship_status || '') || null }];
  });
  return { rows, pageInfo: grid.page_info || null };
}

export async function friendsTemplate(tab) {
  await tab.goto('https://www.facebook.com/friends', { waitUntil: 'load' });
  await tab.network.start('/api/graphql/');
  let cursor = (await tab.network.read({ pattern: '/api/graphql/', limit: 1000 })).cursor;
  await tab.goto(`https://www.facebook.com/friends?opencli_probe=${Date.now()}`, { waitUntil: 'load' });
  let entry;
  for (let attempt = 0; attempt < 24 && !entry; attempt++) {
    const page = await tab.network.read({ pattern: '/api/graphql/', afterSequence: cursor, limit: 100 });
    cursor = page.cursor;
    entry = page.entries.find((item) => item.method === 'POST' && !item.requestBodyTruncated &&
      new URLSearchParams(item.requestBodyPreview || '').get('fb_api_req_friendly_name'));
    if (!entry) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!entry) throw errors.upstream('Facebook did not issue a GraphQL request needed for friend suggestions');
  const id = await tab.evaluate(`require('${PAGE}_facebookRelayOperation')`);
  if (!/^\d+$/.test(String(id || ''))) throw errors.upstream('Facebook did not load the friending GraphQL operation');
  return { form: new URLSearchParams(entry.requestBodyPreview), id };
}

export default defineAdapter({
  description: 'Get Facebook friend suggestions through its GraphQL API.',
  access: 'read', domain: 'facebook.com',
  result: { kind: 'rows', description: 'Friend suggestions', paginated: true },
  args: [
    { name: 'limit', type: 'int', default: 10, min: 1, max: 20 },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous page' },
  ],
  async run({ tab, args }) {
    const limit = Number(args.limit ?? 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw errors.argument('limit must be between 1 and 20');
    const cursor = args.cursor ? String(args.cursor) : null;
    const { form, id } = await friendsTemplate(tab);
    form.set('fb_api_req_friendly_name', PAGE);
    form.set('doc_id', id);
    form.set('variables', JSON.stringify({ count: limit, cursor, location: 'FRIENDS_HOME_MAIN', scale: 1 }));
    const response = await tab.evaluate(`(async () => {
      const response = await fetch('/api/graphql/', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: ${JSON.stringify(form.toString())} });
      if (!response.ok) return { httpError: response.status };
      const text = await response.text();
      try { return JSON.parse(text.split(String.fromCharCode(10))[0].replace(/^for\\s*\\(;;\\);/, '')); }
      catch { return { malformed: true }; }
    })()`);
    if (response?.httpError) throw errors.upstream(`Facebook friends GraphQL returned HTTP ${response.httpError}`);
    if (response?.malformed) throw errors.upstream('Facebook friends GraphQL returned malformed JSON');
    const { rows, pageInfo } = mapFriendSuggestions(response);
    return { rows, ...(pageInfo?.has_next_page && pageInfo?.end_cursor ? { nextCursor: pageInfo.end_cursor } : {}) };
  },
});
