import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnX, gql, resolveUserId, normalizeScreenName, fetchManagedLists, apiError } from './_shared.js';

const LIST_ADD_MEMBER_QUERY_ID = 'vWPi0CTMoPFsjsL6W4IynQ';

function fatalGraphqlErrors(errs) {
  return (Array.isArray(errs) ? errs : []).filter((e) => !(e?.path || []).join('.').includes('default_banner_media_results') && !/decode/i.test(e?.message || ''));
}

/** Add one user to a list (also used by list-add-batch). Returns a result row. */
export async function runListAdd(tab, listId, rawUsername) {
  const username = String(rawUsername || '').replace(/^@/, '').trim();
  if (!/^\d+$/.test(String(listId))) throw errors.argument(`Invalid list_id: ${JSON.stringify(listId)}. Expected a numeric ID.`);
  if (!username || !normalizeScreenName(username)) throw errors.argument('username is required');
  const userId = await resolveUserId(tab, username);
  const lists = await fetchManagedLists(tab);
  const target = lists.find((l) => l.id === listId);
  if (!target) throw errors.upstream(`List ${listId} not found among your lists (${lists.length} fetched).`);
  const memberCountBefore = Number(target.members) || 0;
  let data;
  try { data = await gql(tab, LIST_ADD_MEMBER_QUERY_ID, 'ListAddMember', { listId, userId: String(userId) }, { method: 'POST', features: null }); }
  catch (e) { throw apiError('ListAddMember', e?.data?.status || e?.status || 0); }
  const list = data?.data?.list;
  const mc = list?.member_count;
  const isMember = list?.is_member;
  if (mc === null || mc === undefined) {
    const fatal = fatalGraphqlErrors(data?.errors);
    if (fatal.length) throw errors.upstream(`Failed to add @${username} to list ${listId}: ${fatal.map((e) => e.message || JSON.stringify(e)).join('; ').slice(0, 300)}`);
    throw errors.upstream(`Failed to add @${username} to list ${listId}: no member_count in response`);
  }
  const memberCountAfter = Number(mc);
  if (!Number.isFinite(memberCountAfter) || memberCountAfter < memberCountBefore) throw errors.upstream(`Failed to add @${username} to list ${listId}: member_count check failed`);
  const noop = memberCountAfter === memberCountBefore;
  if (noop && isMember !== true) throw errors.upstream(`Failed to add @${username} to list ${listId}: membership not confirmed`);
  return {
    list_id: listId, username, user_id: String(userId), status: noop ? 'noop' : 'success',
    message: noop ? `@${username} is already a member of list ${listId}` : `Added @${username} to list ${listId} (member_count ${memberCountBefore} -> ${memberCountAfter})`,
  };
}

export default defineAdapter({
  description: 'Add a user to an X list you own (no-op if already a member).',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'list_id', type: 'string', required: true, help: 'Numeric ID of a list you own (from the `lists` command)' },
    { name: 'username', type: 'string', required: true, help: 'Screen name to add (with or without @)' },
  ],
  async run({ tab, args }) {
    await ensureOnX(tab);
    return runListAdd(tab, String(args.list_id || '').trim(), args.username);
  },
});
