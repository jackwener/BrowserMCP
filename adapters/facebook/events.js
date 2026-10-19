import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { safeFacebookUrl } from './_shared.js';

const OPERATION = 'EventCometHomeDiscoverContentRefetchQuery';

export function mapEvents(result) {
  if (result?.errors?.length) throw errors.upstream(`Facebook events API: ${String(result.errors[0]?.message || 'GraphQL error')}`);
  const connection = result?.data?.node?.content_tab?.requested_tab?.events;
  if (!Array.isArray(connection?.edges)) throw errors.upstream('Facebook events API response changed shape');
  const rows = connection.edges.map(({ node }) => {
    const id = String(node?.id || '').trim();
    const name = String(node?.name || '').trim();
    if (!id || !name) return null;
    const timestamp = Number(node.start_timestamp);
    return {
      id, name,
      url: safeFacebookUrl(node.eventUrl) || `https://www.facebook.com/events/${id}/`,
      starts_at: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null,
      when: String(node.day_time_sentence || '').trim() || null,
      place: String(node.event_place?.name || '').trim() || null,
      online: Boolean(node.is_online),
    };
  }).filter(Boolean);
  return { rows, pageInfo: connection.page_info || null };
}

async function eventForm(tab, limit, cursor) {
  await tab.goto('https://www.facebook.com/events', { waitUntil: 'load' });
  await tab.network.start('/api/graphql/');
  let networkCursor = (await tab.network.read({ pattern: '/api/graphql/', limit: 1000 })).cursor;
  await tab.goto(`https://www.facebook.com/events?opencli_events=${Date.now()}`, { waitUntil: 'load' });
  let entry;
  for (let attempt = 0; attempt < 24 && !entry; attempt++) {
    const page = await tab.network.read({ pattern: '/api/graphql/', afterSequence: networkCursor, limit: 100 });
    networkCursor = page.cursor;
    entry = page.entries.find((item) => item.method === 'POST' && !item.requestBodyTruncated &&
      new URLSearchParams(item.requestBodyPreview || '').get('fb_api_req_friendly_name') === OPERATION);
    if (!entry) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!entry) throw errors.upstream('Facebook did not issue an events GraphQL request');
  const form = new URLSearchParams(entry.requestBodyPreview);
  let variables;
  try { variables = JSON.parse(form.get('variables') || '{}'); }
  catch { throw errors.upstream('Facebook events variables are malformed'); }
  if (!variables || typeof variables !== 'object') throw errors.upstream('Facebook events variables are malformed');
  variables.count = limit;
  if (cursor) variables.cursor = cursor;
  form.set('variables', JSON.stringify(variables));
  return form.toString();
}

export default defineAdapter({
  description: 'Discover Facebook events through its logged-in GraphQL API.',
  access: 'read', domain: 'facebook.com',
  result: { kind: 'rows', description: 'Events', paginated: true },
  args: [
    { name: 'limit', type: 'int', default: 9, min: 1, max: 20 },
    { name: 'cursor', type: 'string', help: 'Cursor from a previous page' },
  ],
  async run({ tab, args }) {
    const limit = Number(args.limit ?? 9);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw errors.argument('limit must be between 1 and 20');
    const body = await eventForm(tab, limit, args.cursor || null);
    const response = await tab.evaluate(`(async () => {
      const response = await fetch('/api/graphql/', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: ${JSON.stringify(body)} });
      if (!response.ok) return { httpError: response.status };
      const text = await response.text();
      try { return JSON.parse(text.split(String.fromCharCode(10))[0].replace(/^for\\s*\\(;;\\);/, '')); }
      catch { return { malformed: true }; }
    })()`);
    if (response?.httpError) throw errors.upstream(`Facebook events GraphQL returned HTTP ${response.httpError}`);
    if (response?.malformed) throw errors.upstream('Facebook events GraphQL returned malformed JSON');
    const { rows, pageInfo } = mapEvents(response);
    return { rows, ...(pageInfo?.has_next_page && pageInfo?.end_cursor ? { nextCursor: pageInfo.end_cursor } : {}) };
  },
});
