import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { compact, ensureLinkedIn, linkedinApi } from './_shared.js';
import { linkedinProfile, profileIdentity } from './_profile.js';
import { mapInvitation } from './sent-invitations.js';

export default defineAdapter({
  description: 'Verify a LinkedIn profile and optionally send a connection invitation through the Relationships API.',
  access: 'write', domain: 'linkedin.com',
  result: { kind: 'rows', description: 'Connection invitation outcome' },
  args: [
    { name: 'profile_url', type: 'string', required: true, positional: true },
    { name: 'expected_name', type: 'string', required: true },
    { name: 'note', type: 'string', default: '' },
    { name: 'send', type: 'boolean', default: false },
  ],
  async run({ tab, args }) {
    const identity = profileIdentity(args.profile_url);
    if (identity === 'me') throw errors.argument('profile_url must identify another member');
    const expected = compact(args.expected_name);
    if (!expected) throw errors.argument('expected_name is required');
    const note = String(args.note || '').trim();
    if (note.length > 300) throw errors.argument('note must be at most 300 characters');
    await ensureLinkedIn(tab);
    const profile = await linkedinProfile(tab, identity);
    const name = compact(`${profile.firstName || ''} ${profile.lastName || ''}`);
    const url = `https://www.linkedin.com/in/${encodeURIComponent(profile.publicIdentifier)}/`;
    if (name.toLocaleLowerCase() !== expected.toLocaleLowerCase() || profile.publicIdentifier !== identity) {
      throw errors.argument(`Profile identity mismatch: found ${name} at ${url}`);
    }
    const own = await linkedinProfile(tab, 'me');
    if (own.entityUrn === profile.entityUrn) throw errors.argument('Cannot connect to your own profile');
    if (!args.send) return { rows: [{ status: 'connectable_dry_run', recipient: name, profile_url: url, note_chars: note.length }] };

    const body = { invitee: { inviteeUnion: { memberProfile: profile.entityUrn } } };
    if (note) body.customMessage = note;
    const response = await linkedinApi(tab,
      '/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2',
      { method: 'POST', body });
    let urn = response?.data?.value?.['*invitation'] || response?.data?.value?.invitationUrn || null;
    let verified = false;
    for (let attempt = 0; attempt < 3 && !verified; attempt++) {
      const sent = await linkedinApi(tab,
        '/voyager/api/relationships/sentInvitationViewsV2?q=invitationType&invitationType=CONNECTION&start=0&count=100');
      const match = (sent?.elements || []).map((item) => mapInvitation(item, 0))
        .find((item) => item?.profile_url === url);
      verified = Boolean(match);
      if (match) urn = match.invitation_urn;
      if (!verified && attempt < 2) await new Promise((resolve) => setTimeout(resolve, 750));
    }
    return { rows: [{ status: verified ? 'sent_verified' : 'send_unverified', recipient: name,
      profile_url: url, note_chars: note.length, invitation_urn: urn, delivery_verified: verified }] };
  },
});
