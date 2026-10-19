import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnX, gql, apiError } from './_shared.js';

const QUERY_ID = 'UQRa0jJ9doxGEIQRea1Y0w';
const NAME_MAX = 25;
const DESCRIPTION_MAX = 100;
// Minimal feature set observed in the real CreateList web request; X rejects unknown features.
const FEATURES = {
  profile_label_improvements_pcf_label_in_post_enabled: true, responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false, verified_phone_label_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false, responsive_web_graphql_timeline_navigation_enabled: true,
};

export default defineAdapter({
  description: 'Create a new X list. Returns the new list id.',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'name', type: 'string', required: true, help: `List name (max ${NAME_MAX} chars)` },
    { name: 'description', type: 'string', default: '', help: `Optional list description (max ${DESCRIPTION_MAX} chars)` },
    { name: 'mode', type: 'string', default: 'public', choices: ['public', 'private'], help: 'public or private' },
  ],
  async run({ tab, args }) {
    const name = String(args.name || '').trim();
    const description = String(args.description || '').trim();
    const mode = String(args.mode || 'public').trim().toLowerCase();
    if (!name) throw errors.argument('List name is required');
    if (name.length > NAME_MAX) throw errors.argument(`List name too long: ${name.length} chars (max ${NAME_MAX})`);
    if (description.length > DESCRIPTION_MAX) throw errors.argument(`Description too long: ${description.length} chars (max ${DESCRIPTION_MAX})`);
    if (mode !== 'public' && mode !== 'private') throw errors.argument('mode must be public or private');
    await ensureOnX(tab);
    let data;
    try { data = await gql(tab, QUERY_ID, 'CreateList', { isPrivate: mode === 'private', name, description }, { method: 'POST', features: FEATURES }); }
    catch (e) { throw apiError('CreateList', e?.data?.status || e?.status || 0); }
    const list = data?.data?.list;
    if (!list || typeof list !== 'object') {
      const errs = data?.errors;
      if (Array.isArray(errs) && errs.length) throw errors.upstream(`CreateList failed: ${errs[0].message || JSON.stringify(errs[0])}`);
      throw errors.upstream('CreateList returned no list payload');
    }
    const id = String(list.id_str || list.id || '');
    if (!/^\d+$/.test(id)) throw errors.upstream('CreateList returned no numeric list id');
    return { ok: true, id, name: list.name || name, description: typeof list.description === 'string' ? list.description : description, mode: /private/i.test(list.mode || '') ? 'private' : 'public' };
  },
});
