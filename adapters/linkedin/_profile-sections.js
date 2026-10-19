import { errors } from 'browsermcp/adapter-sdk';
import { compact, linkedinApi } from './_shared.js';

const QUERY_ID = 'voyagerIdentityDashProfileComponents.8903e7f7b15f1c12a050c55d48ca2835';

export async function profileSection(tab, profile, type) {
  if (!['experience', 'education', 'projects'].includes(type)) throw errors.argument('Unsupported profile section');
  const urn = profile?.entityUrn;
  if (!/^urn:li:fsd_profile:[\w-]+$/.test(urn || '')) throw errors.upstream('LinkedIn profile identity changed shape');
  const variables = `(profileUrn:${encodeURIComponent(urn)},sectionType:${type},locale:en_US)`;
  const response = await linkedinApi(tab, `/voyager/api/graphql?variables=${variables}&queryId=${QUERY_ID}`);
  if (response?.errors?.length) throw errors.upstream(`LinkedIn ${type} section failed: ${compact(response.errors[0].message)}`);
  const section = response?.data?.identityDashProfileComponentsBySectionType?.elements?.[0]
    ?.components?.pagedListComponent?.components;
  if (!Array.isArray(section?.elements)) throw errors.upstream(`LinkedIn ${type} section changed shape`);
  if (section.paging?.total > section.elements.length) throw errors.upstream(`LinkedIn ${type} section requires pagination`);
  return section.elements;
}

function children(component) {
  const union = component?.components || component?.componentsUnion || {};
  const entity = union.entityComponent;
  return [
    ...(entity?.subComponents?.components || []),
    ...(union.pagedListComponent?.components?.elements || []),
    ...(union.fixedListComponent?.components || []),
  ];
}

function collectText(component, depth = 0) {
  if (depth > 8) return [];
  const union = component?.components || component?.componentsUnion || {};
  const text = compact(union.textComponent?.text?.text);
  return [text, ...children(component).flatMap((child) => collectText(child, depth + 1))].filter(Boolean);
}

export function mapExperience(components, profileUrl) {
  const rows = [];
  for (const component of components) {
    const entity = component?.components?.entityComponent;
    if (!entity) continue;
    const nested = children(component).flatMap((child) => children(child));
    const positions = nested.filter((child) => child?.components?.entityComponent);
    const entries = positions.length ? positions : [component];
    for (const entry of entries) {
      const role = entry?.components?.entityComponent;
      const title = compact(role?.titleV2?.text?.text || role?.title?.text);
      if (!title) continue;
      const subtitle = compact(role.subtitle?.text || role.subtitleV2?.text?.text);
      const dateRange = compact(role.caption?.text);
      const company = positions.length ? compact(entity.titleV2?.text?.text) : subtitle.split(' · ')[0];
      const description = collectText(entry).join(' ');
      rows.push({ rank: rows.length + 1, total_count: 0, title, company,
        employment_type: positions.length ? compact(entity.subtitle?.text).split(' · ')[0] : subtitle.split(' · ').slice(1).join(' · '),
        date_range: dateRange, description, profile_url: profileUrl,
        raw_text: [title, subtitle, dateRange, description].filter(Boolean).join(' | ') });
    }
  }
  return rows.map((row) => ({ ...row, total_count: rows.length }));
}

export function mapProjects(components, profileUrl) {
  const rows = [];
  for (const component of components) {
    const entity = component?.components?.entityComponent;
    const title = compact(entity?.titleV2?.text?.text || entity?.title?.text);
    if (!title) continue;
    const dateRange = compact(entity.caption?.text);
    const associatedWith = compact(entity.subtitle?.text);
    const description = collectText(component).join(' ');
    rows.push({ rank: rows.length + 1, title, date_range: dateRange,
      associated_with: associatedWith, description, profile_url: profileUrl,
      raw_text: [title, dateRange, associatedWith, description].filter(Boolean).join(' | ') });
  }
  return rows;
}
