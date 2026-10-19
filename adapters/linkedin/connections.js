import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { compact, ensureLinkedIn, integer, linkedinApi, requireElements } from './_shared.js';

const PAGE_SIZE = 40;

export function mapConnection(element, index) {
  const profile = element?.miniProfile;
  const publicId = compact(profile?.publicIdentifier);
  if (!publicId || /[\s/?#]/.test(publicId)) throw errors.upstream('LinkedIn connection has no stable profile identifier');
  return {
    rank: index + 1,
    name: compact([profile.firstName, profile.lastName].filter(Boolean).join(' ')) || publicId,
    occupation: compact(profile.occupation),
    public_id: publicId,
    connected_at: Number.isFinite(element.createdAt) ? element.createdAt : null,
    url: `${'https://www.linkedin.com/in/'}${encodeURIComponent(publicId)}`,
  };
}

export default defineAdapter({
  description: 'List first-degree LinkedIn connections through the Voyager API.',
  access: 'read',
  domain: 'linkedin.com',
  result: { kind: 'rows', description: 'Connections with stable profile URLs', paginated: true },
  args: [
    { name: 'limit', type: 'int', default: 20, min: 1, max: 500, help: 'Maximum connections to return' },
    { name: 'cursor', type: 'int', min: 0, help: 'Offset returned as nextCursor by a previous call' },
  ],
  async run({ tab, args }) {
    await ensureLinkedIn(tab);
    const limit = integer(args.limit, 'limit', 20, 1, 500);
    let offset = integer(args.cursor, 'cursor', 0, 0, Number.MAX_SAFE_INTEGER);
    const rows = [];
    let more = false;
    while (rows.length < limit) {
      const count = Math.min(PAGE_SIZE, limit - rows.length);
      const elements = requireElements(await linkedinApi(tab, `/voyager/api/relationships/connections?start=${offset}&count=${count}`), 'LinkedIn connections');
      for (let index = 0; index < elements.length; index++) rows.push(mapConnection(elements[index], offset + index));
      offset += elements.length;
      more = elements.length === count;
      if (!more) break;
    }
    return { rows, ...(more ? { nextCursor: offset } : {}) };
  },
});
