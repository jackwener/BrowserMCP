import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { facebookGraphql } from './_graphql.js';

function groupAddress(value) {
  const raw = String(value || '').trim();
  let address = raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !['facebook.com', 'www.facebook.com'].includes(url.hostname)) throw errors.argument('group must be on facebook.com');
    address = url.pathname.match(/^\/groups\/([^/]+)\/?$/)?.[1] || '';
  } catch (cause) { if (cause?.code && cause.code !== 'ERR_INVALID_URL') throw cause; }
  if (!/^[A-Za-z0-9._-]{3,100}$/.test(address)) throw errors.argument('group must be a Facebook group ID, address, or URL');
  return address;
}

function rootVariables(groupID) {
  return { groupID, inviteShortLinkKey: null, isChainingRecommendationUnit: false,
    scale: 1, permalinkPostId: null };
}

export function groupInfo(response) {
  const group = response?.data?.group?.profile_header_renderer?.group;
  const id = String(group?.id || '');
  if (!/^\d+$/.test(id)) throw errors.upstream('Facebook group API returned no stable group ID');
  return { id, name: String(group.name || '').trim(),
    state: String(group.viewer_join_state || group.viewer_forum_join_state || '').toUpperCase() };
}

export default defineAdapter({
  description: 'Join a Facebook group through GroupCometJoinForumMutation and verify membership state through GraphQL.',
  access: 'write', domain: 'facebook.com',
  result: { kind: 'rows', description: 'Group membership outcome' },
  args: [{ name: 'group', type: 'string', required: true, positional: true }],
  async run({ tab, args }) {
    const address = groupAddress(args.group);
    const page = `https://www.facebook.com/groups/${encodeURIComponent(address)}/`;
    const initial = groupInfo(await facebookGraphql(tab, page, 'CometGroupRootQuery', rootVariables(address), { allowPartial: true }));
    if (initial.state === 'MEMBER') return { rows: [{ status: 'already_member', group: initial.name, id: initial.id }] };
    if (/PENDING|REQUESTED/.test(initial.state)) return { rows: [{ status: 'request_pending', group: initial.name, id: initial.id }] };
    const actor = await tab.evaluate(`(() => String(require('CurrentUserInitialData').USER_ID || ''))()`);
    if (!/^\d+$/.test(String(actor || ''))) throw errors.auth('Facebook signed-in actor is missing');
    const vars = {
      feedType: 'DISCUSSION', groupID: initial.id,
      input: { action_source: 'GROUP_MALL',
        attribution_id_v2: `CometGroupDiscussionRoot.react,comet.group,via_cold_start,${Date.now()},0,2361831622,,`,
        group_id: initial.id,
        group_share_tracking_params: { app_id: '2220391788200892', exp_id: 'null', is_from_share: false },
        actor_id: actor, client_mutation_id: String(Date.now()) },
      inviteShortLinkKey: null, isChainingRecommendationUnit: false, scale: 2,
      source: 'GROUP_MALL', renderLocation: 'group_mall',
      __relay_internal__pv__groups_comet_use_glvrelayprovider: false,
      __relay_internal__pv__GroupsCometGYSJUnifiedUnitCardImageHeightrelayprovider: 150,
      __relay_internal__pv__GroupsCometGroupChatLazyLoadLastMessageSnippetrelayprovider: false,
    };
    await facebookGraphql(tab, `https://www.facebook.com/groups/${initial.id}/`, 'GroupCometJoinForumMutation', vars);
    let current = initial;
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      current = groupInfo(await facebookGraphql(tab, `https://www.facebook.com/groups/${initial.id}/`,
        'CometGroupRootQuery', rootVariables(initial.id)));
      if (current.state !== initial.state) break;
    }
    const status = current.state === 'MEMBER' ? 'joined'
      : /PENDING|REQUESTED/.test(current.state) ? 'request_pending' : 'request_unverified';
    return { rows: [{ status, group: current.name || initial.name, id: initial.id,
      membership_state: current.state }] };
  },
});
