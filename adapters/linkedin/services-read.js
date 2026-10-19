import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { compact, ensureLinkedIn, linkedinApi } from './_shared.js';
import { linkedinProfile, profileIdentity } from './_profile.js';
import { linkedinProfileCard } from './_profile-card.js';

const QUERY_ID = 'voyagerMarketplacesDashServicesPageView.c3b8eb28842dead1eefc461d582d0cda';

export function servicesVanity(value) {
  let url;
  try { url = new URL(value); } catch { throw errors.argument('services_url must be a LinkedIn Services page URL'); }
  if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname)
    || url.username || url.password || url.port) throw errors.argument('services_url must be on linkedin.com');
  const match = url.pathname.match(/^\/services\/page\/([\w-]+)\/?$/);
  if (!match) throw errors.argument('services_url must be a /services/page/<id>/ URL');
  return match[1];
}

export function servicesUrlFromCard(card) {
  const stack = [card];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (typeof value.actionTarget === 'string' && /^https:\/\/www\.linkedin\.com\/services\/page\//.test(value.actionTarget)) {
      return value.actionTarget;
    }
    stack.push(...Object.values(value).filter((item) => item && typeof item === 'object'));
  }
  return null;
}

export function mapServices(response, vanity) {
  const root = response?.data?.marketplacesDashServicesPageViewByVanityName;
  if (!Array.isArray(root?.elements)) throw errors.upstream('LinkedIn Services API response changed shape');
  const page = root.elements[0];
  if (!page) throw errors.empty('LinkedIn Services page was not found');
  const sections = page.detailViewSectionsResolutionResults;
  if (!Array.isArray(sections)) throw errors.upstream('LinkedIn Services sections changed shape');
  const description = sections.find((section) => section.description)?.description || {};
  const services = sections.find((section) => section.services)?.services?.providedServicesResolutionResults;
  if (!Array.isArray(services)) throw errors.upstream('LinkedIn Services list changed shape');
  const media = page.servicesPageMediaSections?.elements;
  const mediaRows = Array.isArray(media) ? media.map((item) => [compact(item.title?.text || item.title), compact(item.description?.text || item.description)]
    .filter(Boolean).join(' — ')).filter(Boolean) : [];
  const names = services.map((item) => compact(item.name)).filter(Boolean);
  return {
    service_url: `https://www.linkedin.com/services/page/${vanity}/`,
    page_title: compact(page.businessName?.text),
    overview: compact(description.detailsBody?.text),
    availability: compact(description.serviceLocation?.subtitle?.text),
    work_locations: compact(description.serviceLocation?.accessibilityText),
    pricing: compact(description.servicePrice?.subtitle?.text),
    services_provided: names.join('; '), services_count: names.length,
    media: mediaRows.join('\n'), media_count: mediaRows.length,
    messages: null, reviews_visibility: null,
  };
}

export default defineAdapter({
  description: 'Read LinkedIn Services page details through its Voyager GraphQL API.',
  access: 'read', domain: 'linkedin.com',
  result: { kind: 'rows', description: 'LinkedIn Services page' },
  args: [
    { name: 'profile_url', type: 'string', help: 'LinkedIn profile URL; defaults to your profile' },
    { name: 'services_url', type: 'string', help: 'LinkedIn /services/page/<id>/ URL' },
  ],
  async run({ tab, args }) {
    await ensureLinkedIn(tab);
    let url = compact(args.services_url);
    if (!url) {
      const profile = await linkedinProfile(tab, profileIdentity(args.profile_url));
      const card = await linkedinProfileCard(tab, profile, 'SERVICES');
      url = servicesUrlFromCard(card);
      if (!url) throw errors.empty('No Services page is linked from this LinkedIn profile');
    }
    const vanity = servicesVanity(url);
    const response = await linkedinApi(tab,
      `/voyager/api/graphql?includeWebMetadata=true&variables=(vanityName:${vanity})&queryId=${QUERY_ID}`);
    if (response?.errors?.length) throw errors.upstream(`LinkedIn Services API: ${compact(response.errors[0].message)}`);
    return { rows: [mapServices(response, vanity)] };
  },
});
