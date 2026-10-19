import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { compact, ensureLinkedIn, integer, linkedinApi, requireElements } from './_shared.js';

const DECORATION = 'com.linkedin.sales.deco.desktop.searchv2.LeadSearchResult-14';

export function leadSearchPath(keywords, start, count = 25) {
  const query = `(spellCorrectionEnabled:true,recentSearchParam:(doLogHistory:true),keywords:${encodeURIComponent(keywords)})`;
  return `/sales-api/salesApiLeadSearch?q=searchQuery&query=${query}&start=${start}&count=${count}&decorationId=${DECORATION}`;
}

export function mapLead(element) {
  const urn = compact(element?.entityUrn);
  const match = urn.match(/^urn:li:fs_salesProfile:\(([^,()]+),([^,()]+),([^,()]+)\)$/);
  if (!match) throw errors.upstream('Sales Navigator lead has no stable profile identity');
  const position = (Array.isArray(element.currentPositions) ? element.currentPositions[0] : null)
    || (Array.isArray(element.pastPositions) ? element.pastPositions[0] : null) || {};
  return {
    name: compact(element.fullName || [element.firstName, element.lastName].filter(Boolean).join(' ')),
    title: compact(position.title), company: compact(position.companyName),
    location: compact(element.geoRegion), degree: compact(element.degree),
    profile_url: `https://www.linkedin.com/in/${encodeURIComponent(match[1])}`,
    lead_url: `https://www.linkedin.com/sales/lead/${match.slice(1).map(encodeURIComponent).join(',')}`,
    recipient_urn: urn,
  };
}

export default defineAdapter({
  description: 'Search LinkedIn Sales Navigator leads through its sales API. Requires Sales Navigator access.',
  access: 'read', domain: 'linkedin.com',
  result: { kind: 'rows', description: 'Sales Navigator leads', paginated: true },
  args: [
    { name: 'keywords', type: 'string', required: true, help: 'Lead keywords' },
    { name: 'limit', type: 'int', default: 25, min: 1, max: 100 },
    { name: 'cursor', type: 'int', min: 0, help: 'Offset from a previous call' },
  ],
  async run({ tab, args }) {
    const keywords = compact(args.keywords);
    if (!keywords) throw errors.argument('keywords is required');
    await ensureLinkedIn(tab);
    const limit = integer(args.limit, 'limit', 25, 1, 100);
    let offset = integer(args.cursor, 'cursor', 0, 0, Number.MAX_SAFE_INTEGER);
    const rows = [];
    let more = false;
    while (rows.length < limit) {
      const count = Math.min(25, limit - rows.length);
      const elements = requireElements(await linkedinApi(tab, leadSearchPath(keywords, offset, count)), 'Sales Navigator lead search');
      for (let index = 0; index < elements.length; index++) {
        rows.push({ rank: offset + index + 1, ...mapLead(elements[index]) });
      }
      offset += elements.length;
      more = elements.length === count;
      if (!more) break;
    }
    return { rows, ...(more ? { nextCursor: offset } : {}) };
  },
});
