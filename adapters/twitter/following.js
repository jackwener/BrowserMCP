import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnX, gql, resolveUserId, resolveLoggedInUser, normalizeScreenName, apiError } from './_shared.js';

const QUERY_ID = 'F42cDX8PDFxkbjjq6JrM2w';

function extractUser(result) {
  if (!result || result.__typename !== 'User') return null;
  const core = result.core || {};
  const legacy = result.legacy || {};
  const screen_name = core.screen_name || legacy.screen_name || '';
  if (!screen_name) return null;
  return {
    screen_name,
    name: core.name || legacy.name || '',
    bio: legacy.description || result.profile_bio?.description || '',
    followers: legacy.followers_count || legacy.normal_followers_count || 0,
  };
}

export default defineAdapter({
  description: 'Accounts an X user follows (defaults to the logged-in user).',
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'user', type: 'string', help: 'Screen name (with or without @). Omit for the logged-in user.' },
    { name: 'limit', type: 'int', default: 50, help: 'How many accounts to return' },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous call, to page further' },
  ],
  async run({ tab, args }) {
    await ensureOnX(tab);
    const raw = String(args.user || '').trim();
    let user = raw ? normalizeScreenName(raw) : '';
    if (raw && !user) throw errors.argument('user must be a valid X handle', 'Example: { user: "elonmusk" }');
    if (!user) user = await resolveLoggedInUser(tab);
    const userId = await resolveUserId(tab, user);
    const limit = Math.max(1, Number(args.limit) || 50);
    const seen = new Set();
    const rows = [];
    let cursor = args.cursor || undefined;
    for (let guard = 0; rows.length < limit && guard < 40; guard++) {
      const variables = { userId, count: Math.min(50, limit - rows.length + 10), includePromotedContent: false, withClientEventToken: false, withBirdwatchNotes: false, withVoice: true, withV2Timeline: true, ...(cursor && { cursor }) };
      let data;
      try { data = await gql(tab, QUERY_ID, 'Following', variables); }
      catch (e) { if (rows.length) break; throw apiError('Following', e?.data?.status || e?.status || 0); }
      const instructions = data?.data?.user?.result?.timeline_v2?.timeline?.instructions || data?.data?.user?.result?.timeline?.timeline?.instructions || [];
      let nextCursor = null;
      let added = 0;
      for (const inst of instructions) {
        for (const entry of inst.entries || []) {
          const content = entry.content || {};
          if (content.entryType === 'TimelineTimelineCursor' || content.__typename === 'TimelineTimelineCursor') { if (content.cursorType === 'Bottom' || content.cursorType === 'ShowMore') nextCursor = content.value; continue; }
          if (String(entry.entryId || '').startsWith('cursor-')) { nextCursor = content.value || content.itemContent?.value || nextCursor; continue; }
          if (String(entry.entryId || '').startsWith('user-')) {
            const u = extractUser(content.itemContent?.user_results?.result);
            if (u && !seen.has(u.screen_name) && rows.length < limit) { seen.add(u.screen_name); rows.push(u); added++; }
          }
        }
      }
      cursor = nextCursor || undefined;
      if (!added || !cursor) break;
    }
    if (!rows.length) throw errors.empty(`No following accounts found for @${user} (the list may be private)`);
    return { rows, ...(cursor && { nextCursor: cursor }) };
  },
});
