import { defineAdapter } from 'browsermcp/adapter-sdk';
import { ensureLinkedIn, integer } from './_shared.js';
import { collectProfilePosts, linkedinProfile, profileIdentity } from './_profile.js';

export default defineAdapter({
  description: 'Read LinkedIn profile activity through the Voyager member feed API.',
  access: 'read', domain: 'linkedin.com',
  result: { kind: 'rows', description: 'Profile activity posts', paginated: true },
  args: [
    { name: 'profile_url', type: 'string', help: 'LinkedIn /in/<handle>/ URL; defaults to your profile' },
    { name: 'limit', type: 'int', default: 20, min: 1, max: 100 },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous call' },
  ],
  async run({ tab, args }) {
    const identity = profileIdentity(args.profile_url);
    const limit = integer(args.limit, 'limit', 20, 1, 100);
    await ensureLinkedIn(tab);
    const profile = await linkedinProfile(tab, identity);
    return collectProfilePosts(tab, profile, limit, args.cursor);
  },
});
