import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { compact, ensureLinkedIn, linkedinApi } from './_shared.js';

export function jobId(value) {
  const raw = String(value || '').trim();
  if (/^\d{6,20}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && ['linkedin.com', 'www.linkedin.com'].includes(url.hostname)) {
      const id = url.pathname.match(/^\/jobs\/view\/(?:[^/]*-)?(\d{6,20})\/?$/)?.[1];
      if (id) return id;
    }
  } catch { /* invalid input below */ }
  throw errors.argument('job must be a LinkedIn job ID or jobs/view URL');
}

export function mapJobDetail(job, id) {
  if (!job || typeof job !== 'object' || !compact(job.title)) throw errors.upstream('LinkedIn job detail response changed shape');
  const listedAt = Number(job.originalListedAt || job.listedAt);
  const offsite = job.applyMethod?.['com.linkedin.voyager.jobs.OffsiteApply'];
  const workplace = (job.workplaceTypes || []).map((urn) => String(urn).split(':').at(-1));
  return {
    id,
    title: compact(job.title),
    url: `https://www.linkedin.com/jobs/view/${id}`,
    location: compact(job.formattedLocation) || null,
    employment_type: compact(job.formattedEmploymentStatus) || null,
    experience_level: compact(job.formattedExperienceLevel) || null,
    workplace: workplace.includes('2') ? 'remote' : workplace.includes('3') ? 'hybrid' : workplace.includes('1') ? 'onsite' : null,
    salary: compact(job.formattedSalaryDescription) || null,
    listed_at: Number.isFinite(listedAt) && listedAt > 0 ? new Date(listedAt).toISOString() : null,
    applicant_count: Number.isFinite(Number(job.applies)) ? Number(job.applies) : null,
    description: compact(job.description?.text).slice(0, 30_000) || null,
    apply_url: typeof offsite?.companyApplyUrl === 'string' ? offsite.companyApplyUrl : null,
    closed: Boolean(job.applyingInfo?.closed),
  };
}

export default defineAdapter({
  description: 'Read a LinkedIn job posting through the Voyager jobPostings API.',
  access: 'read', domain: 'linkedin.com',
  result: { kind: 'value', description: 'Job detail' },
  args: [{ name: 'job', type: 'string', required: true, help: 'LinkedIn job ID or jobs/view URL' }],
  async run({ tab, args }) {
    const id = jobId(args.job);
    await ensureLinkedIn(tab);
    return mapJobDetail(await linkedinApi(tab, `/voyager/api/jobs/jobPostings/${id}`), id);
  },
});
