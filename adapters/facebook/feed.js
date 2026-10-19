import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { safeFacebookUrl } from './_shared.js';

const ORIGIN = 'https://www.facebook.com';
const INITIAL = 'CometModernHomeFeedQuery';
const PAGE = 'CometNewsFeedPaginationQuery';

export function mapFeedEdges(edges) {
  return edges.flatMap((edge) => {
    const node = edge?.node;
    if (node?.__typename !== 'Story') return [];
    const content = node.comet_sections?.content?.story || node;
    const message = content?.comet_sections?.message?.story || content;
    const id = String(node.post_id || content.post_id || node.id || '').trim();
    if (!id) return [];
    const timestamp = Number(node.creation_time || content.creation_time || 0);
    const actor = content.actors?.[0] || node.actors?.[0];
    return [{
      id,
      author: String(actor?.name || '').trim() || null,
      author_id: String(actor?.id || '').trim() || null,
      text: String(content.message?.text || message?.message?.text || '').trim().slice(0, 5000) || null,
      url: safeFacebookUrl(node.permalink_url || content.wwwURL || content.permalink_url),
      created_at: Number.isFinite(timestamp) && timestamp > 0
        ? new Date(timestamp < 1e10 ? timestamp * 1000 : timestamp).toISOString() : null,
    }];
  });
}

async function bootstrap(tab) {
  await tab.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await tab.network.start('/api/graphql/');
  let cursor = (await tab.network.read({ pattern: '/api/graphql/', limit: 1000 })).cursor;
  await tab.goto(`${ORIGIN}/?opencli_feed=${Date.now()}`, { waitUntil: 'load' });
  let entry;
  for (let attempt = 0; attempt < 24 && !entry; attempt++) {
    const page = await tab.network.read({ pattern: '/api/graphql/', afterSequence: cursor, limit: 100 });
    cursor = page.cursor;
    entry = page.entries.find((item) => item.method === 'POST' && !item.requestBodyTruncated &&
      new URLSearchParams(item.requestBodyPreview || '').get('doc_id'));
    if (!entry) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!entry) throw errors.upstream('Facebook did not issue a GraphQL request needed for the feed');
  const form = new URLSearchParams(entry.requestBodyPreview);
  const operations = await tab.evaluate(`(async () => {
    const initial = require('${INITIAL}_facebookRelayOperation');
    const page = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('pagination operation unavailable')), 5000);
      require('Bootloader').loadModules(['${PAGE}_facebookRelayOperation'], (id) => { clearTimeout(timer); resolve(id); }, 'opencli-feed');
    });
    const variables = require('CometHomeRootEntryPointVariables').getCometFeedVariablesForSk(undefined, undefined, 'COLD_START');
    const providers = require('${INITIAL}$Parameters').params.providedVariables;
    for (const [key, provider] of Object.entries(providers)) variables[key] = provider.get();
    return { initial, page, variables };
  })()`);
  if (!/^\d+$/.test(String(operations?.initial)) || !/^\d+$/.test(String(operations?.page))) {
    throw errors.upstream('Facebook did not expose the current feed GraphQL operations');
  }
  return { form, ...operations };
}

async function fetchFeed(tab, form, name, id, variables) {
  form.set('fb_api_req_friendly_name', name);
  form.set('doc_id', id);
  form.set('variables', JSON.stringify(variables));
  const body = form.toString();
  const response = await tab.evaluate(`(async () => {
    const response = await fetch('/api/graphql/', { method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: ${JSON.stringify(body)} });
    if (!response.ok) return { httpError: response.status };
    const text = await response.text();
    const chunks = text.split(String.fromCharCode(10)).filter(Boolean).map((line) => {
      try { return JSON.parse(line.replace(/^for\\s*\\(;;\\);/, '')); } catch { return null; }
    }).filter(Boolean);
    const firstError = chunks.find((chunk) => chunk.errors?.length)?.errors?.[0]?.message;
    const initialEdges = chunks[0]?.data?.viewer?.news_feed?.edges;
    if (!Array.isArray(initialEdges)) return { malformed: true, firstError };
    const edges = [...initialEdges];
    let pageInfo = chunks[0]?.data?.viewer?.news_feed?.page_info || null;
    for (const chunk of chunks.slice(1)) {
      const path = chunk.path || [];
      if (path.length === 4 && path[0] === 'viewer' && path[1] === 'news_feed' && path[2] === 'edges' && Number.isInteger(path[3])) {
        edges[path[3]] = chunk.data;
      } else if (path.length === 2 && path[0] === 'viewer' && path[1] === 'news_feed' && chunk.data?.page_info) {
        pageInfo = chunk.data.page_info;
      }
    }
    return { edges: edges.filter(Boolean).map((edge) => ({ node: (() => {
      const node = edge.node;
      if (!node) return null;
      const content = node.comet_sections?.content?.story;
      const nested = content?.comet_sections?.message?.story;
      return { __typename: node.__typename, id: node.id, post_id: node.post_id,
        permalink_url: node.permalink_url, creation_time: node.creation_time,
        actors: node.actors, comet_sections: { content: { story: content ? {
          id: content.id, post_id: content.post_id, wwwURL: content.wwwURL,
          permalink_url: content.permalink_url, actors: content.actors,
          message: content.message, comet_sections: { message: { story: nested ? { message: nested.message } : null } },
        } : null } }, };
    })() })), pageInfo, firstError };
  })()`);
  if (response?.httpError) throw errors.upstream(`Facebook feed API returned HTTP ${response.httpError}`);
  if (response?.firstError) throw errors.upstream(`Facebook feed API: ${response.firstError}`);
  if (response?.malformed || !Array.isArray(response?.edges) || !response.pageInfo) {
    throw errors.upstream('Facebook feed API response changed shape');
  }
  return response;
}

export default defineAdapter({
  description: 'Read Facebook news feed posts through its GraphQL API.',
  access: 'read', domain: 'facebook.com',
  result: { kind: 'rows', description: 'News feed posts', paginated: true },
  args: [
    { name: 'limit', type: 'int', default: 10, min: 1, max: 50 },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous page' },
  ],
  async run({ tab, args }) {
    const limit = Number(args.limit ?? 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw errors.argument('limit must be between 1 and 50');
    const { form, initial, page, variables } = await bootstrap(tab);
    const seen = new Set();
    const rows = [];
    let cursor = args.cursor ? String(args.cursor) : null;
    let more = true;
    for (let request = 0; request < 20 && rows.length < limit && more; request++) {
      let result;
      if (!cursor) {
        result = await fetchFeed(tab, form, INITIAL, initial, { ...variables, feedInitialFetchSize: 4 });
      } else {
        const { feedInitialFetchSize, ...rest } = variables;
        result = await fetchFeed(tab, form, PAGE, page, { ...rest, count: Math.min(10, limit - rows.length + 2),
          cursor, clientQueryId: crypto.randomUUID(), clientSession: null,
          experimentalValues: null, focusCommentID: null, referringStoryRenderLocation: null,
          refreshMode: 'AUTO' });
      }
      for (const row of mapFeedEdges(result.edges)) {
        if (!seen.has(row.id)) { rows.push(row); seen.add(row.id); }
      }
      const next = result.pageInfo?.end_cursor || null;
      more = Boolean(result.pageInfo?.has_next_page && next && next !== cursor);
      cursor = next;
    }
    return { rows: rows.slice(0, limit), ...(more && cursor ? { nextCursor: cursor } : {}) };
  },
});
