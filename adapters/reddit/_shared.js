// Shared helpers for the Reddit adapters. Files starting with `_` are not commands.
import { errors } from '@jackwener/browsermcp/adapter-sdk';

/** Be on reddit.com so the same-origin .json fetches carry your session (personalized/over-18/subscribed content). */
export async function ensureOnReddit(tab) {
  const u = await tab.url().catch(() => null);
  if (!u || !/^https?:\/\/([a-z0-9-]+\.)?reddit\.com/i.test(u)) await tab.goto('https://www.reddit.com', { waitUntil: 'load' });
}

/** One reddit `t3` (link) `data` object → a flat, agent-friendly row. */
export function mapPost(p) {
  return {
    id: p.id, title: p.title, author: p.author,
    subreddit: p.subreddit_name_prefixed || (p.subreddit ? `r/${p.subreddit}` : undefined),
    score: p.score, comments: p.num_comments,
    created: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : '',
    flair: p.link_flair_text || undefined, nsfw: p.over_18 || undefined,
    text: p.selftext ? String(p.selftext).slice(0, 2000) : undefined,
    link: p.url && !p.is_self ? p.url : undefined,
    permalink: p.permalink ? `https://www.reddit.com${p.permalink}` : undefined,
  };
}

/** One reddit `t1` (comment) `data` object → a flat, agent-friendly row. */
export function mapComment(d) {
  return {
    id: d.id, author: d.author,
    subreddit: d.subreddit_name_prefixed || (d.subreddit ? `r/${d.subreddit}` : undefined),
    score: d.score,
    body: d.body ? String(d.body).slice(0, 2000) : undefined,
    created: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : '',
    permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : undefined,
  };
}

/** A reddit listing `data.children[]` → flat post rows (t3 only). */
export function postRows(json) {
  return (json?.data?.children || []).filter((c) => c.kind === 't3').map((c) => mapPost(c.data));
}

/** A reddit listing `data.children[]` → flat comment rows (t1 only). */
export function commentRows(json) {
  return (json?.data?.children || []).filter((c) => c.kind === 't1').map((c) => mapComment(c.data));
}

/** A mixed listing (e.g. saved / upvoted) → rows, mapping posts and comments in order. */
export function mixedRows(json) {
  return (json?.data?.children || [])
    .map((c) => (c.kind === 't3' ? mapPost(c.data) : c.kind === 't1' ? mapComment(c.data) : null))
    .filter(Boolean);
}

export function assertListing(json) {
  if (!json || json.error) throw json?.error === 403 ? errors.auth('Reddit: forbidden (private/quarantined or not logged in)') : errors.upstream(`Reddit: ${json?.message || 'no listing returned'}`);
}

/** Extract a bare reddit post id from an id / t3_ fullname / comments URL. */
export function toPostId(value) {
  let s = String(value || '').trim();
  const m = s.match(/comments\/([a-z0-9]+)/i);
  if (m) return m[1].toLowerCase();
  return s.replace(/^t3_/i, '').toLowerCase();
}

/** Normalise an id / fullname / URL into a `t3_` link fullname. */
export function toPostFullname(value) {
  let s = String(value || '').trim();
  const m = s.match(/comments\/([a-z0-9]+)/i);
  if (m) s = m[1];
  return s.startsWith('t3_') || s.startsWith('t1_') ? s : `t3_${s}`;
}

/** Normalise an id / fullname / URL into a `t1_` comment fullname. */
export function toCommentFullname(value) {
  let s = String(value || '').trim();
  const m = s.match(/comments\/[a-z0-9]+\/[^/]+\/([a-z0-9]+)/i);
  if (m) s = m[1];
  s = s.replace(/^t1_/i, '');
  return `t1_${s}`;
}

/** The logged-in identity ({ name, modhash, ... }). Throws an auth error when anonymous. */
export async function redditMe(tab) {
  let me;
  try {
    me = await tab.fetchJson('https://www.reddit.com/api/me.json?raw_json=1');
  } catch {
    throw errors.auth('Reddit: not logged in', 'Open reddit.com and sign in, then retry.');
  }
  const data = me?.data || me;
  if (!data || !data.name) throw errors.auth('Reddit: not logged in', 'Open reddit.com and sign in, then retry.');
  return data;
}

/**
 * Form-POST a Reddit web action using the session modhash (uh). Returns the parsed JSON.
 * The web endpoints (`/api/vote`, `/api/save`, `/api/comment`, ...) accept the browser session +
 * modhash — no OAuth bearer needed. Throws upstream on a Reddit `json.errors` payload.
 */
export async function redditPost(tab, path, params = {}, { needModhash = true } = {}) {
  const form = { ...params };
  if (needModhash) {
    const me = await redditMe(tab);
    if (me.modhash) form.uh = me.modhash;
  }
  const body = new URLSearchParams(form).toString();
  const json = await tab.fetchJson(`https://www.reddit.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const errs = json?.json?.errors;
  if (Array.isArray(errs) && errs.length) throw errors.upstream(`Reddit: ${errs.map((e) => (Array.isArray(e) ? e.join(': ') : String(e))).join('; ')}`);
  return json;
}
