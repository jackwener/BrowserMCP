import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnBili, biliApi, biliApiSigned, resolveBvid, parsePageArg, selectVideoPart } from './_shared.js';

export default defineAdapter({
  description: 'Fetch the subtitle track of a Bilibili video as timed cues. Accepts a BV id, URL, or b23.tv link.',
  access: 'read',
  domain: 'bilibili.com',
  args: [
    { name: 'bvid', type: 'string', required: true, help: 'BV id, video URL, or b23.tv short link' },
    { name: 'lang', type: 'string', help: 'Subtitle language code (e.g. zh-CN, en-US, ai-zh). Defaults to the first available.' },
    { name: 'page', type: 'int', help: 'Multi-part (分P) selection, 1-based. Defaults to P1.' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const bvid = await resolveBvid(args.bvid);
    const selectedPage = parsePageArg(args.page);

    const viewData = await biliApi(tab, '/x/web-interface/view', { bvid });
    const cid = selectedPage != null ? selectVideoPart(viewData, selectedPage).cid : viewData?.cid;
    if (!cid) throw errors.upstream(`Could not resolve cid for bvid=${bvid}`);

    const player = await biliApiSigned(tab, '/x/player/wbi/v2', { bvid, cid });
    const needLogin = player?.need_login_subtitle === true;
    const subtitles = player?.subtitle?.subtitles;
    if (!Array.isArray(subtitles)) throw errors.upstream('Bilibili player API returned a malformed subtitle list');
    if (subtitles.length === 0) {
      if (needLogin) throw errors.auth('Subtitles for this video are hidden behind login.');
      throw errors.empty('This video has no subtitles.');
    }

    const target = args.lang ? subtitles.find((s) => s.lan === args.lang) || subtitles[0] : subtitles[0];
    let subUrl = typeof target?.subtitle_url === 'string' ? target.subtitle_url.trim() : '';
    if (!subUrl) throw errors.auth('Empty subtitle_url (risk control or not logged in).');
    if (subUrl.startsWith('//')) subUrl = 'https:' + subUrl;
    if (!/^https?:\/\//i.test(subUrl)) throw errors.upstream(`Invalid subtitle URL: ${subUrl}`);

    const doc = await tab.fetchJson(subUrl);
    const body = Array.isArray(doc?.body) ? doc.body : (Array.isArray(doc) ? doc : null);
    if (!Array.isArray(body)) throw errors.upstream('Subtitle document was not in the expected format');
    if (body.length === 0) throw errors.empty('Subtitle file contained no cues.');

    return body.map((item, idx) => ({
      index: idx + 1,
      from_s: Number(item?.from) || 0,
      to_s: Number(item?.to) || 0,
      content: String(item?.content ?? ''),
    }));
  },
});
