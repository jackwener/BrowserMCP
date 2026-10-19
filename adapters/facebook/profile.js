import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { facebookGraphql } from './_graphql.js';
import { parseProfileSearch, safeFacebookUrl, searchProfilesApi } from './_shared.js';

function profileHandle(value) {
  const raw = String(value || '').trim();
  if (/^\d{10,20}$/.test(raw)) return { id: raw };
  let handle = raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !['facebook.com', 'www.facebook.com'].includes(url.hostname)) throw errors.argument('username must be a Facebook profile');
    if (url.pathname === '/profile.php' && /^\d{10,20}$/.test(url.searchParams.get('id') || '')) return { id: url.searchParams.get('id') };
    handle = url.pathname.replace(/^\/+|\/+$/g, '');
  } catch (cause) { if (cause?.code && cause.code !== 'ERR_INVALID_URL') throw cause; }
  if (!/^[A-Za-z0-9._-]{3,100}$/.test(handle)) throw errors.argument('username must be a Facebook username, ID, or profile URL');
  return { handle };
}

export function mapFacebookProfile(response, requested) {
  const user = response?.data?.user?.profile_header_renderer?.user;
  const id = String(user?.id || '');
  const name = String(user?.name || '').trim();
  const url = safeFacebookUrl(user?.url);
  if (!/^\d+$/.test(id) || !name || !url || (requested.id && requested.id !== id)) {
    throw errors.upstream('Facebook profile header returned no matching user');
  }
  const username = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
  if (requested.handle && username.toLowerCase() !== requested.handle.toLowerCase()) {
    throw errors.upstream('Facebook profile header returned a different username');
  }
  return { name, username, id, friends: '-', followers: '-', url };
}

export default defineAdapter({
  description: 'Read a Facebook user profile through ProfileCometHeaderQuery.',
  access: 'read', domain: 'facebook.com',
  result: { kind: 'rows', description: 'Facebook profile' },
  args: [{ name: 'username', type: 'string', required: true, positional: true }],
  async run({ tab, args }) {
    const requested = profileHandle(args.username);
    let id = requested.id;
    if (!id) {
      await tab.goto('https://www.facebook.com/', { waitUntil: 'load' });
      const own = await tab.evaluate(`(() => { try { return String(require('CurrentUserInitialData').USER_ID || '') } catch { return '' } })()`);
      if (/^\d{10,20}$/.test(own)) {
        const response = await facebookGraphql(tab, 'https://www.facebook.com/me', 'ProfileCometHeaderQuery',
          { userID: own, scale: 1, shouldUseFXIMProfilePicEditor: false });
        const url = response?.data?.user?.profile_header_renderer?.user?.url;
        try { if (new URL(url).pathname.replace(/^\/+|\/+$/g, '').toLowerCase() === requested.handle.toLowerCase()) {
          return { rows: [mapFacebookProfile(response, requested)] };
        } } catch {}
      }
      const { rows } = parseProfileSearch(await searchProfilesApi(tab, requested.handle, 'people', 10));
      const exact = rows.find((item) => {
        try { return new URL(item.url).pathname.replace(/^\/+|\/+$/g, '').toLowerCase() === requested.handle.toLowerCase(); }
        catch { return false; }
      });
      if (!exact?.id) throw errors.empty(`Facebook username ${requested.handle} was not found`);
      id = exact.id;
    }
    const pageUrl = `https://www.facebook.com/profile.php?id=${encodeURIComponent(id)}`;
    const response = await facebookGraphql(tab, pageUrl, 'ProfileCometHeaderQuery',
      { userID: id, scale: 1, shouldUseFXIMProfilePicEditor: false });
    return { rows: [mapFacebookProfile(response, requested)] };
  },
});
