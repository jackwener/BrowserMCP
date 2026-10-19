import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { friendMutation, resolveFriendId } from './_friending.js';

export default defineAdapter({
  description: 'Cancel a pending Facebook friend request through the friending GraphQL API.',
  access: 'write', domain: 'facebook.com',
  result: { kind: 'value', description: 'Friend request status' },
  args: [{ name: 'user', type: 'string', required: true, help: 'Facebook user ID, username, or profile URL' }],
  async run({ tab, args }) {
    if (!args.user) throw errors.argument('user is required');
    const id = await resolveFriendId(tab, args.user);
    return friendMutation(tab, 'cancel', id);
  },
});
