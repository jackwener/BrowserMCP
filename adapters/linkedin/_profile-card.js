import { errors } from '@jackwener/browsermcp/adapter-sdk';
import { compact, linkedinApi } from './_shared.js';

export function profileCardUrn(profile, type) {
  if (type === 'EXPERIENCE' && profile.experienceCardUrn) return profile.experienceCardUrn;
  if (type === 'EDUCATION' && profile.educationCardUrn) return profile.educationCardUrn;
  const id = String(profile?.entityUrn || '').match(/^urn:li:fsd_profile:([\w-]+)$/)?.[1];
  const locale = String(profile?.experienceCardUrn || '').match(/,([\w-]+)\)$/)?.[1]
    || [profile?.primaryLocale?.language, profile?.primaryLocale?.country].filter(Boolean).join('_') || 'en_US';
  if (!id || !/^[A-Z_]+$/.test(type) || !/^[\w-]+$/.test(locale)) throw errors.upstream('LinkedIn profile card identity is invalid');
  return `urn:li:fsd_profileCard:(${id},${type},${locale})`;
}

export async function linkedinProfileCard(tab, profile, type) {
  const urn = profileCardUrn(profile, type);
  const card = await linkedinApi(tab, `/voyager/api/voyagerIdentityDashProfileCards/${encodeURIComponent(urn)}`);
  if (!card || !Array.isArray(card.topComponents)) throw errors.upstream(`LinkedIn ${type} profile card changed shape`);
  return card;
}

function componentText(component) {
  const union = component?.componentsUnion || {};
  if (union.textComponent) return compact(union.textComponent.text?.text);
  if (union.entityComponent) {
    const entity = union.entityComponent;
    const main = [entity.titleV2?.text?.text || entity.title?.text, entity.subtitle?.text, entity.caption?.text]
      .map(compact).filter(Boolean);
    const nested = sectionLines(entity.subComponents?.components || []);
    return [main.join(' · '), ...nested].filter(Boolean).join('; ');
  }
  if (union.fixedListComponent) return sectionLines(union.fixedListComponent.components || []).join('; ');
  return '';
}

export function sectionLines(components) {
  if (!Array.isArray(components)) return [];
  return components.map(componentText).filter(Boolean);
}

export function cardText(card) {
  return sectionLines(card?.topComponents?.slice(1) || []).join('; ');
}
