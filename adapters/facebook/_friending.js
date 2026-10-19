import { errors } from '@jackwener/browsermcp/adapter-sdk';
import { parseProfileSearch, searchProfilesApi } from './_shared.js';
import { friendsTemplate } from './friends.js';

export async function resolveFriendId(tab, value) {
  const raw = String(value || '').trim();
  if (/^\d{10,20}$/.test(raw)) return raw;
  let handle = raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !['facebook.com', 'www.facebook.com'].includes(url.hostname)) throw errors.argument('user must be a Facebook profile');
    const id = url.pathname === '/profile.php' ? url.searchParams.get('id') : null;
    if (id && /^\d{10,20}$/.test(id)) return id;
    handle = url.pathname.replace(/^\/+|\/+$/g, '');
  } catch (cause) {
    if (cause?.code && cause.code !== 'ERR_INVALID_URL') throw cause;
  }
  if (!/^[A-Za-z0-9._-]{3,100}$/.test(handle)) throw errors.argument('user must be a Facebook ID, username, or profile URL');
  const { rows } = parseProfileSearch(await searchProfilesApi(tab, handle, 'people', 10));
  const exact = rows.find((row) => {
    try { return new URL(row.url).pathname.replace(/^\/+|\/+$/g, '').toLowerCase() === handle.toLowerCase(); }
    catch { return false; }
  });
  if (!exact?.id) throw errors.empty(`Facebook username ${handle} could not be resolved to one profile`);
  return exact.id;
}

export async function friendMutation(tab, action, id) {
  const { form } = await friendsTemplate(tab);
  const actor = form.get('__user');
  if (!/^\d+$/.test(String(actor || ''))) throw errors.auth('Facebook GraphQL request has no signed-in actor');
  const operation = action === 'send' ? 'FriendingCometFriendRequestSendMutation' : 'FriendingCometFriendRequestCancelMutation';
  const docId = await tab.evaluate(`require('${operation}_facebookRelayOperation')`);
  if (!/^\d+$/.test(String(docId || ''))) throw errors.upstream(`Facebook did not load ${operation}`);
  const input = {
    actor_id: actor,
    client_mutation_id: String(Date.now()),
    click_correlation_id: String(Date.now()),
    click_proof_validation_result: JSON.stringify({ validated: true }),
    friending_channel: 'FRIENDS_HOME_MAIN',
    ...(action === 'send' ? { friend_requestee_ids: [id], warn_ack_for_ids: [] }
      : { cancelled_friend_requestee_id: id, attribution_id_v2: null }),
  };
  form.set('fb_api_req_friendly_name', operation);
  form.set('doc_id', docId);
  const scale = await tab.evaluate('devicePixelRatio');
  form.set('variables', JSON.stringify({ input, scale: Number(scale) || 1 }));
  const response = await tab.evaluate(`(async () => {
    const response = await fetch('/api/graphql/', { method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: ${JSON.stringify(form.toString())} });
    if (!response.ok) return { httpError: response.status };
    const text = await response.text();
    try { return JSON.parse(text.split(String.fromCharCode(10))[0].replace(/^for\\s*\\(;;\\);/, '')); }
    catch { return { malformed: true }; }
  })()`);
  if (response?.httpError) throw errors.upstream(`Facebook friending GraphQL returned HTTP ${response.httpError}`);
  if (response?.malformed) throw errors.upstream('Facebook friending GraphQL returned malformed JSON');
  if (response?.errors?.length) throw errors.upstream(`Facebook friending API: ${String(response.errors[0]?.message || 'GraphQL error')}`);
  const result = action === 'send'
    ? response?.data?.friend_request_send?.friend_requestees?.find((user) => user?.id === id)
    : response?.data?.friend_request_cancel?.cancelled_friend_requestee;
  if (result?.id !== id) throw errors.upstream('Facebook friending API did not confirm the requested user');
  return { user_id: id, status: String(result.friendship_status || '') };
}
