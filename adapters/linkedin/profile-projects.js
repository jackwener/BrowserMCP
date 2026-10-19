import { defineAdapter } from '@jackwener/browsermcp/adapter-sdk';
import { ensureLinkedIn } from './_shared.js';
import { linkedinProfile, profileIdentity } from './_profile.js';
import { mapProjects, profileSection } from './_profile-sections.js';

export default defineAdapter({
  description: 'Read LinkedIn profile Projects through Voyager GraphQL.',
  access: 'read', domain: 'linkedin.com',
  result: { kind: 'rows', description: 'Profile projects' },
  args: [{ name: 'profile_url', type: 'string', help: 'LinkedIn /in/<handle>/ URL; defaults to your profile' }],
  async run({ tab, args }) {
    const identity = profileIdentity(args.profile_url);
    await ensureLinkedIn(tab);
    const profile = await linkedinProfile(tab, identity);
    const url = `https://www.linkedin.com/in/${encodeURIComponent(profile.publicIdentifier)}/`;
    return { rows: mapProjects(await profileSection(tab, profile, 'projects'), url) };
  },
});
