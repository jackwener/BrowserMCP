import { errors } from 'browsermcp/adapter-sdk';
import { compact, linkedinApi, requireElements } from './_shared.js';

export function profileIdentity(value) {
  const raw = compact(value);
  if (!raw) return 'me';
  let url;
  try { url = new URL(raw); }
  catch { throw errors.argument('profile_url must be a LinkedIn /in/<handle>/ URL'); }
  if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname)
    || url.username || url.password || url.port) throw errors.argument('profile_url must be on linkedin.com');
  const match = url.pathname.match(/^\/in\/([^/]+)\/?$/);
  if (!match) throw errors.argument('profile_url must be a LinkedIn /in/<handle>/ URL');
  let slug;
  try { slug = decodeURIComponent(match[1]); }
  catch { throw errors.argument('profile_url contains an invalid handle'); }
  if (!/^[\w.-]+$/.test(slug)) throw errors.argument('profile_url contains an invalid handle');
  return slug;
}

export async function linkedinProfile(tab, identity) {
  const elements = requireElements(await linkedinApi(tab,
    `/voyager/api/voyagerIdentityDashProfiles?q=memberIdentity&memberIdentity=${encodeURIComponent(identity)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfile-76`), 'LinkedIn profile');
  const profile = elements.find((item) => item?.entityUrn && item?.publicIdentifier);
  if (!profile) throw errors.empty(`No LinkedIn profile found for ${identity}`);
  return profile;
}

export function profileFeedPath(profileUrn, count, start = 0, token = '') {
  const params = new URLSearchParams({ q: 'memberFeed', profileUrn, count: String(count), start: String(start) });
  if (token) params.set('paginationToken', token);
  return `/voyager/api/voyagerFeedDashProfileUpdates?${params}`;
}

export function profileFeedCursor(value) {
  if (!value) return { start: 0, token: '' };
  let parsed;
  try { parsed = JSON.parse(String(value)); } catch { throw errors.argument('cursor is invalid'); }
  if (!Number.isSafeInteger(parsed?.start) || parsed.start < 0 || typeof parsed?.token !== 'string'
    || parsed.token.length > 4000) throw errors.argument('cursor is invalid');
  return parsed;
}

export function activityDate(urn) {
  const id = String(urn || '').match(/:(\d{15,22})$/)?.[1];
  if (!id) return null;
  const ms = Number(BigInt(id) >> 22n);
  const date = new Date(ms);
  return ms > 946684800000 && ms < 4102444800000 && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function linkedinUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname)) return null;
    return `${url.origin}${url.pathname}`;
  } catch { return null; }
}

function imageUrls(contentUnion) {
  const images = contentUnion?.imageComponent?.images || [];
  return images.flatMap((image) => (image?.attributes || []).flatMap((attribute) => {
    const vector = attribute?.detailDataUnion?.vectorImage;
    if (!vector?.rootUrl || !Array.isArray(vector.artifacts)) return [];
    const artifact = [...vector.artifacts].sort((a, b) => Number(b.width || 0) - Number(a.width || 0))[0];
    const path = artifact?.fileIdentifyingUrlPathSegment;
    const url = path ? `${vector.rootUrl}${path}` : null;
    return url?.startsWith('https://') ? [url] : [];
  }));
}

export function mapProfileUpdate(update, rank) {
  const id = compact(update?.metadata?.backendUrn || update?.entityUrn);
  if (!id) return null;
  const metrics = update?.socialDetail?.totalSocialActivityCounts || {};
  const mediaType = Object.keys(update?.contentUnion || {})[0] || '';
  const url = linkedinUrl(update?.socialContent?.shareUrl)
    || `https://www.linkedin.com/feed/update/${encodeURIComponent(id)}/`;
  const body = compact(update?.commentary?.text?.text || update?.contentUnion?.celebrationComponent?.headline?.text);
  return {
    rank, id, author: compact(update?.actor?.name?.text),
    author_url: linkedinUrl(update?.actor?.navigationContext?.actionTarget),
    posted_at: activityDate(update?.metadata?.shareUrn || id),
    posted_at_label: compact(update?.actor?.subDescription?.text),
    body, reactions: Number(metrics.numLikes || 0), comments: Number(metrics.numComments || 0),
    reposts: Number(metrics.numShares || 0), impressions: Number(metrics.numImpressions || 0),
    media: mediaType.replace(/Component$/, '') || null,
    media_urls: imageUrls(update?.contentUnion).join(' | '), url, raw_text: body,
  };
}

export async function collectProfilePosts(tab, profile, limit, cursor = '') {
  const parsed = profileFeedCursor(cursor);
  let { start, token } = parsed;
  const rows = [];
  const seen = new Set();
  for (let page = 0; page < 30 && rows.length < limit; page++) {
    const count = Math.min(20, limit - rows.length);
    const response = await linkedinApi(tab, profileFeedPath(profile.entityUrn, count, start, token));
    const elements = requireElements(response, 'LinkedIn profile activity');
    for (const [index, element] of elements.entries()) {
      const row = mapProfileUpdate(element, start + index + 1);
      if (row && !seen.has(row.id)) { seen.add(row.id); rows.push(row); }
    }
    const next = compact(response.metadata?.paginationToken);
    start += elements.length;
    if (!next || next === token || !elements.length) return { rows };
    token = next;
    if (elements.length < count) return { rows };
  }
  return { rows, ...(token ? { nextCursor: JSON.stringify({ start, token }) } : {}) };
}
