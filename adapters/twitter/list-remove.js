import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnX, gql, resolveUserId, normalizeScreenName, apiError } from './_shared.js';

const LIST_REMOVE_MEMBER_QUERY_ID = 'Com5Rc7DZWUC5EPWTZjvXQ';

/** Remove one user from a list (also used by list-remove-batch). Returns a result row. */
export async function runListRemove(tab, listId, rawUsername) {
  const username = normalizeScreenName(rawUsername);
  if (!/^\d+$/.test(String(listId))) throw errors.argument(`Invalid list_id: ${JSON.stringify(listId)}. Expected a numeric ID.`);
  if (!username) throw errors.argument('username is required');
  const userId = await resolveUserId(tab, username);
  let data;
  try { data = await gql(tab, LIST_REMOVE_MEMBER_QUERY_ID, 'ListRemoveMember', { listId: String(listId), userId: String(userId) }, { method: 'POST', features: null }); }
  catch (e) { throw apiError('ListRemoveMember', e?.data?.status || e?.status || 0); }
  if (Array.isArray(data?.errors) && data.errors.length) throw errors.upstream(`Failed to remove @${username} from list ${listId}: ${data.errors.map((e) => e.message).join('; ').slice(0, 300)}`);
  return { list_id: String(listId), username, user_id: String(userId), status: 'success', message: `Removed @${username} from list ${listId}` };
}

export default defineAdapter({
  description: 'Remove a user from an X list you own.',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'list_id', type: 'string', required: true, help: 'Numeric ID of a list you own' },
    { name: 'username', type: 'string', required: true, help: 'Screen name to remove (with or without @)' },
  ],
  async run({ tab, args }) { await ensureOnX(tab); return runListRemove(tab, String(args.list_id || '').trim(), args.username); },
});
