import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { safeFacebookUrl } from './_shared.js';

const ROOT = 'CometNotificationsRootQuery';
const PAGE = 'CometNotificationsListPaginationQuery';
const FLAGS = ['IS_COMET', 'INCLUDE_WA_P2B_NOTIFS'];

export function mapNotifications(response) {
  if (response?.errors?.length) throw errors.upstream(`Facebook notifications API: ${String(response.errors[0]?.message || 'GraphQL error')}`);
  const connection = response?.data?.viewer?.notifications_page;
  if (!Array.isArray(connection?.edges)) throw errors.upstream('Facebook notifications API response changed shape');
  const rows = connection.edges.flatMap(({ node }) => {
    const notif = node?.notif;
    const id = String(notif?.notif_id || '').trim();
    if (!id) return [];
    const timestamp = Number(notif.creation_time?.timestamp);
    return [{
      id,
      text: String(notif.body?.text || '').trim(),
      unread: !['SEEN_AND_READ', 'READ'].includes(String(notif.seen_state || '')),
      time: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null,
      url: safeFacebookUrl(notif.url),
      type: String(notif.notif_type || '').trim() || null,
    }];
  });
  return { rows, pageInfo: connection.page_info || null };
}

async function notificationTemplate(tab) {
  await tab.goto('https://www.facebook.com/notifications/', { waitUntil: 'load' });
  await tab.network.start('/api/graphql/');
  let cursor = (await tab.network.read({ pattern: '/api/graphql/', limit: 1000 })).cursor;
  await tab.goto(`https://www.facebook.com/notifications/?opencli_probe=${Date.now()}`, { waitUntil: 'load' });
  let entry;
  for (let attempt = 0; attempt < 24 && !entry; attempt++) {
    const page = await tab.network.read({ pattern: '/api/graphql/', afterSequence: cursor, limit: 100 });
    cursor = page.cursor;
    entry = page.entries.find((item) => item.method === 'POST' && !item.requestBodyTruncated &&
      new URLSearchParams(item.requestBodyPreview || '').get('fb_api_req_friendly_name'));
    if (!entry) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!entry) throw errors.upstream('Facebook did not issue a GraphQL request needed for notifications');
  const ids = await tab.evaluate(`({ root: require('${ROOT}_facebookRelayOperation'), page: require('${PAGE}_facebookRelayOperation') })`);
  if (!/^\d+$/.test(String(ids?.root || '')) || !/^\d+$/.test(String(ids?.page || ''))) {
    throw errors.upstream('Facebook did not load notification GraphQL operations');
  }
  return { form: new URLSearchParams(entry.requestBodyPreview), ids };
}

export default defineAdapter({
  description: 'Read Facebook notifications through its logged-in GraphQL API.',
  access: 'read', domain: 'facebook.com',
  result: { kind: 'rows', description: 'Notifications', paginated: true },
  args: [
    { name: 'limit', type: 'int', default: 15, min: 1, max: 100 },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous page' },
  ],
  async run({ tab, args }) {
    const limit = Number(args.limit ?? 15);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw errors.argument('limit must be between 1 and 100');
    const cursor = args.cursor ? String(args.cursor) : null;
    const { form, ids } = await notificationTemplate(tab);
    const operation = cursor ? PAGE : ROOT;
    form.set('fb_api_req_friendly_name', operation);
    form.set('doc_id', cursor ? ids.page : ids.root);
    form.set('variables', JSON.stringify(cursor
      ? { count: limit, cursor, environment: 'MAIN_SURFACE', filter_tokens: [], notif_cache_ids: [], notif_query_flags: FLAGS, scale: 1 }
      : { count: limit, environment: 'MAIN_SURFACE', filter_tokens: [], scale: 1 }));
    const response = await tab.evaluate(`(async () => {
      const response = await fetch('/api/graphql/', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: ${JSON.stringify(form.toString())} });
      if (!response.ok) return { httpError: response.status };
      const text = await response.text();
      try { return JSON.parse(text.split(String.fromCharCode(10))[0].replace(/^for\\s*\\(;;\\);/, '')); }
      catch { return { malformed: true }; }
    })()`);
    if (response?.httpError) throw errors.upstream(`Facebook notifications GraphQL returned HTTP ${response.httpError}`);
    if (response?.malformed) throw errors.upstream('Facebook notifications GraphQL returned malformed JSON');
    const { rows, pageInfo } = mapNotifications(response);
    return { rows, ...(pageInfo?.has_next_page && pageInfo?.end_cursor ? { nextCursor: pageInfo.end_cursor } : {}) };
  },
});
