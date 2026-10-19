import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { safeFacebookUrl } from './_shared.js';

const OPERATION = 'GroupsCometLeftRailContainerQuery';

export function mapGroups(response, kind = 'all') {
  if (response?.errors?.length) throw errors.upstream(`Facebook groups API: ${String(response.errors[0]?.message || 'GraphQL error')}`);
  const collections = [
    ['member', response?.data?.nonAdminGroups?.groups_tab?.tab_groups_list?.edges],
    ['managed', response?.data?.adminGroups?.groups_tab?.tab_groups_list?.edges],
  ];
  if (collections.some(([, edges]) => !Array.isArray(edges))) throw errors.upstream('Facebook groups API response changed shape');
  return collections.flatMap(([groupKind, edges]) => kind !== 'all' && kind !== groupKind ? [] : edges.flatMap(({ node }) => {
    const id = String(node?.id || '').trim();
    const name = String(node?.name || '').trim();
    if (!id || !name) return [];
    const timestamp = Number(node.last_post_time);
    const ms = timestamp < 1e10 ? timestamp * 1000 : timestamp;
    return [{ id, name, kind: groupKind,
      url: safeFacebookUrl(node.url) || `https://www.facebook.com/groups/${encodeURIComponent(id)}/`,
      last_post_at: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null }];
  }));
}

export default defineAdapter({
  description: 'List joined and managed Facebook groups through its GraphQL API.',
  access: 'read', domain: 'facebook.com',
  result: { kind: 'rows', description: 'Groups' },
  args: [
    { name: 'limit', type: 'int', default: 20, min: 1, max: 50 },
    { name: 'kind', type: 'string', default: 'all', choices: ['all', 'member', 'managed'] },
  ],
  async run({ tab, args }) {
    const limit = Number(args.limit ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw errors.argument('limit must be between 1 and 50');
    const kind = String(args.kind || 'all');
    if (!['all', 'member', 'managed'].includes(kind)) throw errors.argument('kind must be all, member, or managed');
    await tab.goto('https://www.facebook.com/groups/feed/', { waitUntil: 'load' });
    await tab.network.start('/api/graphql/');
    let cursor = (await tab.network.read({ pattern: '/api/graphql/', limit: 1000 })).cursor;
    await tab.goto(`https://www.facebook.com/groups/feed/?opencli_probe=${Date.now()}`, { waitUntil: 'load' });
    let entry;
    for (let attempt = 0; attempt < 24 && !entry; attempt++) {
      const page = await tab.network.read({ pattern: '/api/graphql/', afterSequence: cursor, limit: 100 });
      cursor = page.cursor;
      entry = page.entries.find((item) => item.method === 'POST' && !item.requestBodyTruncated &&
        new URLSearchParams(item.requestBodyPreview || '').get('fb_api_req_friendly_name'));
      if (!entry) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!entry) throw errors.upstream('Facebook did not issue a GraphQL request needed for groups');
    const id = await tab.evaluate(`require('${OPERATION}_facebookRelayOperation')`);
    if (!/^\d+$/.test(String(id || ''))) throw errors.upstream('Facebook did not load the groups GraphQL operation');
    const form = new URLSearchParams(entry.requestBodyPreview);
    form.set('fb_api_req_friendly_name', OPERATION);
    form.set('doc_id', id);
    form.set('variables', JSON.stringify({ adminGroupsCount: limit, memberGroupsCount: limit, scale: 1 }));
    const response = await tab.evaluate(`(async () => {
      const response = await fetch('/api/graphql/', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: ${JSON.stringify(form.toString())} });
      if (!response.ok) return { httpError: response.status };
      const text = await response.text();
      try { return JSON.parse(text.split(String.fromCharCode(10))[0].replace(/^for\\s*\\(;;\\);/, '')); }
      catch { return { malformed: true }; }
    })()`);
    if (response?.httpError) throw errors.upstream(`Facebook groups GraphQL returned HTTP ${response.httpError}`);
    if (response?.malformed) throw errors.upstream('Facebook groups GraphQL returned malformed JSON');
    return { rows: mapGroups(response, kind).slice(0, limit) };
  },
});
