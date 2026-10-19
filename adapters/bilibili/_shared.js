// Shared helpers for the Bilibili adapters. Files starting with `_` are not commands.
import { errors } from '@jackwener/browsermcp/adapter-sdk';
import { createHash } from 'node:crypto';
import https from 'node:https';

/** Be on bilibili.com so page-context fetches to api.bilibili.com carry the .bilibili.com session cookies. */
export async function ensureOnBili(tab) {
  const u = await tab.url().catch(() => null);
  if (!u || !/^https?:\/\/([a-z0-9-]+\.)?bilibili\.com/i.test(u)) await tab.goto('https://www.bilibili.com', { waitUntil: 'load' });
}

/** Bilibili treats these codes / messages as auth/permission failures rather than app errors. */
function isAuthLike(code, message) {
  return code === -101 || code === -111 || code === -400 || code === -403 || /csrf|登录|账号|权限|forbidden|permission|login/i.test(String(message ?? ''));
}

/** Unwrap a Bilibili `{ code, message, data }` envelope, routing auth failures to errors.auth. */
function unwrap(res, label) {
  if (!res || typeof res !== 'object') throw errors.upstream(`Bilibili ${label || ''} returned no JSON`.trim());
  if (res.code !== 0) {
    if (isAuthLike(res.code, res.message)) throw errors.auth(`Bilibili: ${res.message || 'not logged in'} (${res.code})`);
    throw errors.upstream(`Bilibili error ${res.code}: ${res.message || 'unknown'}`);
  }
  return res.data;
}

/** GET a Bilibili web-interface JSON endpoint through the logged-in page; unwrap { code, message, data }. */
export async function biliGet(tab, url) {
  return unwrap(await tab.fetchJson(url), '');
}

/** Build an api.bilibili.com URL with query params (spaces as %20, per Bilibili's WBI expectations). */
function buildUrl(path, params) {
  const entries = Object.entries(params).map(([k, v]) => [k, String(v)]);
  const qs = new URLSearchParams(Object.fromEntries(entries)).toString().replace(/\+/g, '%20');
  return `https://api.bilibili.com${path}${qs ? `?${qs}` : ''}`;
}

/** GET an api.bilibili.com path with unsigned params. */
export async function biliApi(tab, path, params = {}) {
  return biliGet(tab, buildUrl(path, params));
}

/** GET an api.bilibili.com path with WBI-signed params. */
export async function biliApiSigned(tab, path, params = {}) {
  const signed = await wbiSign(tab, params);
  return biliGet(tab, buildUrl(path, signed));
}

/** POST form-encoded params to an api.bilibili.com path; auto-attaches the bili_jct CSRF token. */
export async function biliPost(tab, path, params = {}) {
  const csrf = await tab.cookie('bili_jct');
  const body = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])));
  body.set('csrf', csrf || '');
  const res = await tab.fetchJson(`https://api.bilibili.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return unwrap(res, 'write');
}

// ---------------------------------------------------------------------------
// WBI signing — many read endpoints reject unsigned requests with 403/-403.
// Ported faithfully from the corpus utils.js.
// ---------------------------------------------------------------------------
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

/** Raw nav payload (not unwrapped: nav returns code -101 when logged out but still carries wbi_img). */
async function getNavData(tab) {
  const res = await tab.fetchJson('https://api.bilibili.com/x/web-interface/nav');
  return res && typeof res === 'object' ? res : {};
}

async function getWbiKeys(tab) {
  const nav = await getNavData(tab);
  const wbiImg = nav?.data?.wbi_img ?? {};
  const imgKey = (wbiImg.img_url ?? '').split('/').pop()?.split('.')[0] ?? '';
  const subKey = (wbiImg.sub_url ?? '').split('/').pop()?.split('.')[0] ?? '';
  return { imgKey, subKey };
}

function getMixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i] || '').join('').slice(0, 32);
}

/** Sign a params object with Bilibili's WBI scheme; returns a new params object incl. wts + w_rid. */
export async function wbiSign(tab, params) {
  const { imgKey, subKey } = await getWbiKeys(tab);
  const mixinKey = getMixinKey(imgKey, subKey);
  const wts = Math.floor(Date.now() / 1000);
  const sorted = {};
  const allParams = { ...params, wts: String(wts) };
  for (const key of Object.keys(allParams).sort()) {
    sorted[key] = String(allParams[key]).replace(/[!'()*]/g, '');
  }
  // Bilibili WBI verification expects %20 for spaces, not + (URLSearchParams default).
  const query = new URLSearchParams(sorted).toString().replace(/\+/g, '%20');
  sorted.w_rid = createHash('md5').update(query + mixinKey).digest('hex');
  return sorted;
}

// ---------------------------------------------------------------------------
// Identity / resolution helpers
// ---------------------------------------------------------------------------

/** The logged-in user's mid; throws auth if not logged in. */
export async function getSelfUid(tab) {
  const nav = await getNavData(tab);
  const mid = nav?.data?.mid;
  if (!mid) throw errors.auth('Not logged in to Bilibili');
  return String(mid);
}

/** Resolve a bare uid, or search a username → mid. */
export async function resolveUid(tab, input) {
  const s = String(input ?? '').trim();
  if (/^\d+$/.test(s)) return s;
  const data = await biliApiSigned(tab, '/x/web-interface/wbi/search/type', { search_type: 'bili_user', keyword: s });
  const results = data?.result;
  if (!Array.isArray(results)) throw errors.upstream(`Bilibili user search returned malformed result for ${s}`);
  const mid = String(results[0]?.mid ?? '').trim();
  if (!mid) throw errors.empty(`No Bilibili user found for: ${s}`);
  return mid;
}

/** Resolve a BV id, bilibili.com video URL, or b23.tv short link → a BV id. */
export function resolveBvid(input) {
  const trimmed = String(input).trim();
  if (/^BV[A-Za-z0-9]+$/i.test(trimmed)) return Promise.resolve(trimmed);
  try {
    const parsed = new URL(trimmed);
    if (/(\.|^)bilibili\.com$/i.test(parsed.hostname)) {
      const match = parsed.pathname.match(/\/(?:video|bangumi\/play)\/(BV[A-Za-z0-9]+)/i);
      if (match) return Promise.resolve(match[1]);
    }
  } catch {
    // Non-URL inputs fall through to b23.tv short-code resolution.
  }
  const shortCode = trimmed.replace(/^https?:\/\//, '').replace(/^(www\.)?b23\.tv\//, '');
  if (!/^[A-Za-z0-9]+$/.test(shortCode)) {
    return Promise.reject(errors.argument(`Cannot resolve BV ID from invalid input: ${trimmed}`));
  }
  const url = 'https://b23.tv/' + shortCode;
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const location = res.headers.location;
      const match = location && location.match(/\/video\/(BV[A-Za-z0-9]+)/);
      res.resume();
      if (match) resolve(match[1]);
      else reject(errors.argument(`Cannot resolve BV ID from short URL: ${trimmed}`));
    });
    req.on('error', reject);
    req.setTimeout(4000, () => { req.destroy(); reject(errors.upstream(`Timeout resolving short URL: ${trimmed}`)); });
  });
}

// ---------------------------------------------------------------------------
// Multi-part (分P) selection — used by video / download / subtitle / summary.
// ---------------------------------------------------------------------------

/** Parse a 1-based --page selector; '' / null → null (no drill-down). */
export function parsePageArg(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 1) return value;
    throw errors.argument(`page must be a positive integer, got: ${value}`);
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw errors.argument(`page must be a positive integer, got: ${String(value)}`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw errors.argument(`page is too large: ${value}`);
  return n;
}

function readApiPositiveInteger(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  throw errors.upstream(`Bilibili view API returned a malformed ${label}`);
}

/** Pick the Nth (1-based) entry from view API data.pages[]. Fails closed on missing/duplicate/malformed. */
export function selectVideoPart(viewData, pageNum) {
  const pages = Array.isArray(viewData?.pages) ? viewData.pages : null;
  if (!pages || pages.length === 0) throw errors.upstream('Bilibili view API did not return pages[] for page selection');
  const matches = [];
  for (const entry of pages) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw errors.upstream('Bilibili view API returned a malformed pages[] entry');
    if (readApiPositiveInteger(entry.page, 'page number') === pageNum) matches.push(entry);
  }
  if (matches.length > 1) throw errors.upstream(`Bilibili view API returned duplicate page entries for p=${pageNum}`);
  const part = matches[0];
  if (!part) {
    const total = pages.length || viewData?.videos || 1;
    throw errors.argument(`Page out of range: p=${pageNum} (this video has ${total} part(s))`);
  }
  readApiPositiveInteger(part.cid, `cid for p=${pageNum}`);
  return part;
}

// ---------------------------------------------------------------------------
// Relation helpers — used by follow / unfollow.
// ---------------------------------------------------------------------------
const RELATION_VERIFY_TIMEOUT_MS = 5000;
const RELATION_VERIFY_POLL_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Extract a mid from a space.bilibili.com/<uid> URL, else ''. */
export function parseSpaceMidUrl(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed;
  try { parsed = new URL(candidate); } catch { return ''; }
  if (parsed.hostname.toLowerCase() !== 'space.bilibili.com') return '';
  const match = parsed.pathname.match(/^\/(\d+)\/?$/);
  return match ? match[1] : '';
}

/** Current relation attribute toward a user (2=following, 6=mutual, 128=blocked, ...). */
export async function fetchRelationAttribute(tab, mid) {
  const data = await biliGet(tab, `https://api.bilibili.com/x/relation?fid=${mid}`);
  const attribute = data?.attribute;
  if (typeof attribute !== 'number') throw errors.upstream('Bilibili relation query returned a malformed attribute');
  return attribute;
}

/** Poll the relation until `predicate(attribute)` holds, or throw. */
export async function waitForRelation(tab, mid, predicate, expectedLabel) {
  const deadline = Date.now() + RELATION_VERIFY_TIMEOUT_MS;
  let lastAttribute;
  while (Date.now() <= deadline) {
    lastAttribute = await fetchRelationAttribute(tab, mid);
    if (predicate(lastAttribute)) return lastAttribute;
    await sleep(RELATION_VERIFY_POLL_MS);
  }
  throw errors.upstream(`Bilibili relation modify did not verify ${expectedLabel}; last attribute=${lastAttribute}`);
}

/** Strip HTML tags / entities from a search-result snippet. */
export function stripHtml(s) {
  return String(s ?? '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
}
