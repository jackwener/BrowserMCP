import { errors } from '@jackwener/browsermcp/adapter-sdk';

const ORIGIN = 'https://www.facebook.com';
const SEARCH_OPERATION = 'SearchCometResultsPaginatedResultsQuery';

export function safeFacebookUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, ORIGIN);
    if (url.protocol !== 'https:' || !['facebook.com', 'www.facebook.com'].includes(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

export function parseProfileSearch(json) {
  if (Array.isArray(json?.errors) && json.errors.length) throw errors.upstream(`Facebook search API: ${String(json.errors[0]?.message || 'GraphQL error')}`);
  const result = json?.data?.serpResponse?.results;
  if (!result || !Array.isArray(result.edges)) throw errors.upstream('Facebook search API response changed shape');
  const rows = result.edges.map((edge) => {
    const view = edge?.rendering_strategy?.view_model;
    const profile = view?.loggedProfile;
    if (!profile?.id || !profile?.name) return null;
    return {
      id: String(profile.id),
      name: String(profile.name).trim(),
      url: safeFacebookUrl(profile.url || view?.profile?.url),
      description: String(view?.primary_snippet_text_with_entities?.text || '').trim() || null,
      picture: typeof profile?.typeaheadProfilePicture?.uri === 'string' ? profile.typeaheadProfilePicture.uri : null,
    };
  }).filter(Boolean);
  return { rows, pageInfo: result.page_info || null };
}

/** Bootstrap a current GraphQL document and CSRF form from Facebook's own search request. */
async function searchForm(tab, query, type, limit, cursor) {
  const normalized = String(query || '').trim();
  if (!normalized) throw errors.argument('query is required');
  if (!['people', 'groups', 'pages'].includes(type)) throw errors.argument('type must be people, groups, or pages');
  const path = '/api/graphql/';
  await tab.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await tab.network.start(path);
  const before = (await tab.network.read({ pattern: path, limit: 1000 })).cursor;
  await tab.goto(`${ORIGIN}/search/${type}/?q=${encodeURIComponent(normalized)}`, { waitUntil: 'load' });
  let networkCursor = before;
  let entry;
  for (let attempt = 0; attempt < 24 && !entry; attempt++) {
    const page = await tab.network.read({ pattern: path, afterSequence: networkCursor, limit: 100 });
    networkCursor = page.cursor;
    entry = page.entries.find((item) => {
      if (item.method !== 'POST' || item.requestBodyTruncated || !item.requestBodyPreview) return false;
      return new URLSearchParams(item.requestBodyPreview).get('fb_api_req_friendly_name') === SEARCH_OPERATION;
    });
    if (!entry) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!entry) throw errors.upstream('Facebook did not issue a search GraphQL request');
  const form = new URLSearchParams(entry.requestBodyPreview);
  let variables;
  try { variables = JSON.parse(form.get('variables') || '{}'); } catch { throw errors.upstream('Facebook search variables are malformed'); }
  if (!variables?.args || variables.args.text !== normalized || variables.args.experience?.type !== `${type.toUpperCase()}_TAB`) throw errors.upstream('Facebook search request did not match the query');
  variables.cursor = cursor;
  variables.count = limit;
  form.set('variables', JSON.stringify(variables));
  return form;
}

export async function searchProfilesApi(tab, query, type, limit, cursor = null) {
  const form = await searchForm(tab, query, type, limit, cursor);
  const path = '/api/graphql/';
  const body = form.toString();
  const response = await tab.evaluate(`(async () => {
    const response = await fetch('${path}', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: ${JSON.stringify(body)},
    });
    const text = await response.text();
    if (!response.ok) return { httpError: response.status };
    try { return JSON.parse(text.replace(/^for\\s*\\(;;\\);/, '')); }
    catch { return { malformed: true }; }
  })()`);
  if (response?.httpError) throw errors.upstream(`Facebook GraphQL returned HTTP ${response.httpError}`);
  if (response?.malformed) throw errors.upstream('Facebook GraphQL returned malformed JSON');
  return response;
}

export function parsePostRows(result) {
  if (Array.isArray(result?.errors) && result.errors.length) throw errors.upstream(`Facebook posts search API: ${String(result.errors[0]?.message || 'GraphQL error')}`);
  if (!Array.isArray(result?.edges)) throw errors.upstream('Facebook posts search API response changed shape');
  const rows = result.edges.map((edge) => {
    const story = edge?.rendering_strategy?.view_model?.click_model?.story;
    if (!story) return null;
    const content = story.comet_sections?.content?.story;
    const nested = content?.comet_sections?.message?.story;
    const id = String(story.post_id || story.id || '').trim();
    const url = safeFacebookUrl(story.permalink_url || nested?.permalink_url || content?.permalink_url);
    if (!id || !url) return null;
    const timestamp = Number(story.creation_time || 0);
    return {
      id,
      author: String(story.actors?.[0]?.name || content?.actors?.[0]?.name || '').trim() || null,
      author_id: String(story.actors?.[0]?.id || content?.actors?.[0]?.id || '').trim() || null,
      text: String(story.message?.text || content?.message?.text || nested?.message?.text || '').trim().slice(0, 5000) || null,
      url,
      created_at: timestamp > 0 ? new Date(timestamp < 1e10 ? timestamp * 1000 : timestamp).toISOString() : null,
    };
  }).filter(Boolean);
  return { rows, pageInfo: result.pageInfo || null };
}

/** Posts stream large deferred media patches; return only first-chunk story fields. */
export async function searchPostsApi(tab, query, limit, cursor = null) {
  const form = await searchForm(tab, query, 'groups', limit, cursor);
  const variables = JSON.parse(form.get('variables'));
  variables.args.experience.type = 'POSTS_TAB';
  form.set('variables', JSON.stringify(variables));
  const response = await tab.evaluate(`(async () => {
    const response = await fetch('/api/graphql/', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: ${JSON.stringify(form.toString())},
    });
    if (!response.ok) return { httpError: response.status };
    const text = await response.text();
    let json;
    try { json = JSON.parse(text.split(String.fromCharCode(10))[0].replace(/^for\\s*\\(;;\\);/, '')); }
    catch { return { malformed: true }; }
    const result = json?.data?.serpResponse?.results;
    return { edges: (result?.edges || []).map((edge) => ({
      rendering_strategy: { view_model: { click_model: { story: (() => {
        const story = edge?.rendering_strategy?.view_model?.click_model?.story;
        const content = story?.comet_sections?.content?.story;
        const nested = content?.comet_sections?.message?.story;
        return story ? {
          id: story.id, post_id: story.post_id, permalink_url: story.permalink_url,
          creation_time: story.creation_time, actors: story.actors,
          message: story.message,
          comet_sections: { content: { story: content ? {
            actors: content.actors, message: content.message, permalink_url: content.permalink_url,
            comet_sections: { message: { story: nested ? { message: nested.message, permalink_url: nested.permalink_url } : null } },
          } : null } },
        } : null;
      })() } } },
    })), pageInfo: result?.page_info, errors: json?.errors };
  })()`);
  if (response?.httpError) throw errors.upstream(`Facebook posts GraphQL returned HTTP ${response.httpError}`);
  if (response?.malformed) throw errors.upstream('Facebook posts GraphQL returned malformed JSON');
  return response;
}
