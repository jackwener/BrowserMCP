import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnX, gql, apiError } from './_shared.js';

const QUERY_ID = 'i78YDd0Tza-dWKw5H2Y7WA';
const FEATURES = {
  rweb_tipjar_consumption_enabled: false, responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false, creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
};

function parseFolders(data, seen) {
  const folders = [];
  const slice = data?.data?.viewer?.bookmark_collections_slice
    || data?.data?.viewer_v2?.user_results?.result?.bookmark_collections_slice
    || data?.data?.bookmark_collections_slice || null;
  const items = slice?.items || slice?.timeline?.timeline?.instructions?.flatMap?.((i) => i.entries || []) || [];
  for (const item of items) {
    const folder = item?.bookmarkCollection || item?.content?.bookmarkCollection || item?.content?.itemContent?.bookmark_collection || item;
    const id = folder?.id_str || folder?.id || folder?.rest_id || '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    folders.push({
      id: String(id),
      name: String(folder?.name || folder?.collection_name || ''),
      items: Number(folder?.bookmarks_count ?? folder?.items_count ?? folder?.count ?? 0) || 0,
      created_at: String(folder?.created_at || folder?.timestamp_ms || ''),
    });
  }
  return folders;
}

export default defineAdapter({
  description: 'Your X bookmark folders (user-created collections under Bookmarks). Returns id, name, item count, created_at.',
  access: 'read',
  domain: 'x.com',
  args: [],
  async run({ tab }) {
    await ensureOnX(tab);
    let data;
    try { data = await gql(tab, QUERY_ID, 'bookmarkFoldersSlice', {}, { features: FEATURES }); }
    catch (e) { throw apiError('bookmarkFoldersSlice', e?.data?.status || e?.status || 0, 'account may not have folder access'); }
    const folders = parseFolders(data, new Set());
    if (!folders.length) throw errors.empty('No bookmark folders found');
    return folders;
  },
});
