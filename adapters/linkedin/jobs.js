import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { compact, ensureLinkedIn, integer, linkedinApi, requireElements } from './_shared.js';

const EXPERIENCE = { internship: '1', entry: '2', associate: '3', mid: '4', senior: '4', director: '5', executive: '6' };
const JOB_TYPE = { 'full-time': 'F', 'part-time': 'P', contract: 'C', temporary: 'T', volunteer: 'V', internship: 'I' };
const DATE = { any: 'on', month: 'r2592000', week: 'r604800', day: 'r86400' };
const WORKPLACE = { onsite: '1', hybrid: '3', remote: '2' };

function option(value, mapping, label) {
  if (!value) return null;
  const resolved = mapping[String(value).toLowerCase()];
  if (!resolved) throw errors.argument(`Unsupported ${label}: ${value}`);
  return resolved;
}

export function jobCardsPath(input, offset, count) {
  const filters = [];
  const experience = option(input.experience, EXPERIENCE, 'experience');
  const jobType = option(input.job_type, JOB_TYPE, 'job_type');
  const date = option(input.date_posted, DATE, 'date_posted');
  const workplace = option(input.workplace, WORKPLACE, 'workplace');
  if (experience) filters.push(`experience:List(${experience})`);
  if (jobType) filters.push(`jobType:List(${jobType})`);
  if (date) filters.push(`timePostedRange:List(${date})`);
  if (workplace) filters.push(`workplaceType:List(${workplace})`);
  const parts = [
    `origin:${filters.length ? 'JOB_SEARCH_PAGE_JOB_FILTER' : 'JOB_SEARCH_PAGE_OTHER_ENTRY'}`,
    `keywords:${compact(input.query)}`,
  ];
  if (input.location) parts.push(`locationUnion:(seoLocation:(location:${compact(input.location)}))`);
  if (filters.length) parts.push(`selectedFilters:(${filters.join(',')})`);
  parts.push('spellCorrectionEnabled:true');
  const query = `(${parts.join(',')})`;
  const params = new URLSearchParams({
    decorationId: 'com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220',
    count: String(count), q: 'jobSearch',
  });
  const encodedQuery = encodeURIComponent(query)
    .replace(/%3A/gi, ':').replace(/%2C/gi, ',')
    .replace(/%28/gi, '(').replace(/%29/gi, ')');
  return `/voyager/api/voyagerJobsDashJobCards?${params}&query=${encodedQuery}&start=${offset}`;
}

export function mapJobCard(element, index) {
  const card = element?.jobCardUnion?.jobPostingCard;
  if (!card) return null;
  const urn = [card.jobPostingUrn, card.jobPosting?.entityUrn, card.entityUrn].find((value) => /\d+/.test(String(value || '')));
  const id = String(urn || '').match(/\d+/)?.[0] || null;
  if (!id) return null;
  const listedAt = (card.footerItems || []).find((item) => item?.type === 'LISTED_DATE')?.timeAt;
  return {
    rank: index + 1,
    id,
    title: compact(card.jobPostingTitle || card.title?.text),
    company: compact(card.primaryDescription?.text),
    location: compact(card.secondaryDescription?.text),
    salary: compact(card.tertiaryDescription?.text) || null,
    listed: Number.isFinite(Number(listedAt)) ? new Date(Number(listedAt)).toISOString().slice(0, 10) : null,
    url: `https://www.linkedin.com/jobs/view/${id}`,
  };
}

export default defineAdapter({
  description: 'Search LinkedIn jobs through the Voyager jobs API.',
  aliases: ['search'],
  access: 'read', domain: 'linkedin.com',
  result: { kind: 'rows', description: 'Job cards', paginated: true },
  args: [
    { name: 'query', type: 'string', required: true, help: 'Job keywords' },
    { name: 'location', type: 'string', help: 'Location name' },
    { name: 'experience', type: 'string', choices: Object.keys(EXPERIENCE) },
    { name: 'job_type', type: 'string', choices: Object.keys(JOB_TYPE) },
    { name: 'date_posted', type: 'string', choices: Object.keys(DATE) },
    { name: 'workplace', type: 'string', choices: Object.keys(WORKPLACE) },
    { name: 'limit', type: 'int', default: 20, min: 1, max: 100 },
    { name: 'cursor', type: 'int', min: 0, help: 'Offset from a previous call' },
  ],
  async run({ tab, args }) {
    if (!compact(args.query)) throw errors.argument('query is required');
    await ensureLinkedIn(tab);
    const limit = integer(args.limit, 'limit', 20, 1, 100);
    let offset = integer(args.cursor, 'cursor', 0, 0, Number.MAX_SAFE_INTEGER);
    const rows = [];
    let more = false;
    while (rows.length < limit) {
      const count = Math.min(25, limit - rows.length);
      const elements = requireElements(await linkedinApi(tab, jobCardsPath(args, offset, count)), 'LinkedIn jobs');
      for (const element of elements) {
        const row = mapJobCard(element, offset + rows.length);
        if (row) rows.push(row);
      }
      offset += elements.length;
      more = elements.length === count;
      if (!more || !elements.length) break;
    }
    return { rows: rows.slice(0, limit), ...(more ? { nextCursor: offset } : {}) };
  },
});
