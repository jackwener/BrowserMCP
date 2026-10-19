import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { compact, ensureLinkedIn, linkedinApi, requireElements } from './_shared.js';

export function mapInvitation(element, rank) {
  const invitation = element?.invitation;
  const member = invitation?.toMember || invitation?.invitee?.['com.linkedin.voyager.relationships.invitation.ProfileInvitee']?.miniProfile;
  if (!invitation?.entityUrn || !member?.publicIdentifier) return null;
  const time = Number(invitation.sentTime);
  return {
    rank,
    name: compact(`${member.firstName || ''} ${member.lastName || ''}`),
    profile_url: `https://www.linkedin.com/in/${encodeURIComponent(member.publicIdentifier)}/`,
    invited_at: Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null,
    invitation_urn: invitation.entityUrn,
  };
}

export default defineAdapter({
  description: 'List pending sent LinkedIn connection invitations through the Relationships API.',
  access: 'read', domain: 'linkedin.com',
  result: { kind: 'rows', description: 'Sent invitations' },
  args: [],
  async run({ tab }) {
    await ensureLinkedIn(tab);
    const rows = [];
    const seen = new Set();
    for (let start = 0; start < 1000; start += 50) {
      const response = await linkedinApi(tab,
        `/voyager/api/relationships/sentInvitationViewsV2?q=invitationType&invitationType=CONNECTION&start=${start}&count=50`);
      const elements = requireElements(response, 'LinkedIn sent invitations');
      for (const item of elements) {
        const row = mapInvitation(item, rows.length + 1);
        if (!row) throw errors.upstream('LinkedIn invitation is missing a stable profile identity');
        if (!seen.has(row.invitation_urn)) { seen.add(row.invitation_urn); rows.push(row); }
      }
      if (elements.length < 50) break;
    }
    return { rows };
  },
});
