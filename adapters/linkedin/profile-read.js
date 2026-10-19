import { defineAdapter } from '@jackwener/browsermcp/adapter-sdk';
import { compact, ensureLinkedIn } from './_shared.js';
import { linkedinProfile, profileIdentity } from './_profile.js';
import { cardText, linkedinProfileCard, sectionLines } from './_profile-card.js';

export default defineAdapter({
  description: 'Read LinkedIn profile details and sections through the Voyager profile APIs.',
  access: 'read', domain: 'linkedin.com',
  result: { kind: 'rows', description: 'LinkedIn profile details' },
  args: [{ name: 'profile_url', type: 'string', help: 'LinkedIn /in/<handle>/ URL; defaults to your profile' }],
  async run({ tab, args }) {
    const identity = profileIdentity(args.profile_url);
    await ensureLinkedIn(tab);
    const profile = await linkedinProfile(tab, identity);
    const sections = {};
    for (const type of ['ABOUT', 'EXPERIENCE', 'EDUCATION', 'SERVICES', 'FEATURED']) {
      sections[type] = await linkedinProfileCard(tab, profile, type);
    }
    const about = cardText(sections.ABOUT);
    const aboutSkills = sectionLines(sections.ABOUT.subComponents || []);
    const name = compact(`${profile.firstName || ''} ${profile.lastName || ''}`);
    return { rows: [{
      profile_url: `https://www.linkedin.com/in/${encodeURIComponent(profile.publicIdentifier)}/`,
      name, headline: compact(profile.headline),
      location: compact(profile.geoLocation?.geo?.defaultLocalizedName || profile.location?.countryCode),
      location_urn: profile.geoLocation?.geoUrn || null, industry: compact(profile.industry?.name),
      about, about_character_count: about ? `${about.length}/2,600` : '', about_skills: aboutSkills.join('; '),
      experience: cardText(sections.EXPERIENCE), education: cardText(sections.EDUCATION),
      services: cardText(sections.SERVICES), featured: cardText(sections.FEATURED),
    }] };
  },
});
