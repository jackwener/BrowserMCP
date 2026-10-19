import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { compact, ensureLinkedIn, integer, linkedinApi } from './_shared.js';

const QUERY_ID = 'voyagerSearchDashClusters.e438ab99259203e9c1cd3f358e217282';

export function peopleSearchPath(keywords, start, count) {
  const word = compact(keywords);
  if (!word || word.length > 200) throw errors.argument('keywords must be 1–200 characters');
  const encoded = encodeURIComponent(word).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const variables = `(start:${start},count:${count},origin:GLOBAL_SEARCH_HEADER,query:(keywords:${encoded},flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(PEOPLE))),includeFiltersInResponse:false))`;
  return `/voyager/api/graphql?variables=${variables}&queryId=${QUERY_ID}`;
}

export function peopleRows(response) {
  const clusters = response?.data?.searchDashClustersByAll?.elements;
  if (!Array.isArray(clusters)) throw errors.upstream('LinkedIn people search response changed shape');
  const seen = new Set();
  const rows = [];
  for (const cluster of clusters) for (const item of cluster.items || []) {
    const entity = item?.item?.entityResult;
    const raw = entity?.navigationUrl;
    let url;
    try { url = new URL(raw); } catch { continue; }
    if (url.protocol !== 'https:' || url.hostname !== 'www.linkedin.com' || !/^\/in\/[^/]+\/?$/.test(url.pathname)) continue;
    const profileUrl = `${url.origin}${url.pathname.replace(/\/?$/, '/')}`;
    if (seen.has(profileUrl)) continue;
    const name = compact(entity.title?.text);
    if (!name) continue;
    seen.add(profileUrl);
    rows.push({ rank: rows.length + 1, name, headline: compact(entity.primarySubtitle?.text),
      location: compact(entity.secondarySubtitle?.text), profile_url: profileUrl });
  }
  return rows;
}

export default defineAdapter({
  description: 'Search LinkedIn people through Voyager Search GraphQL.',
  access: 'read', domain: 'linkedin.com',
  result: { kind: 'rows', description: 'People search results' },
  args: [
    { name: 'keywords', type: 'string', required: true, positional: true },
    { name: 'limit', type: 'int', default: 5, min: 1, max: 25 },
  ],
  async run({ tab, args }) {
    const limit = integer(args.limit, 'limit', 5, 1, 25);
    const path = peopleSearchPath(args.keywords, 0, limit);
    await ensureLinkedIn(tab);
    const response = await linkedinApi(tab, path);
    if (response?.errors?.length) throw errors.upstream(`LinkedIn people search failed: ${compact(response.errors[0].message)}`);
    return { rows: peopleRows(response).slice(0, limit) };
  },
});
