import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnBili, biliApi, resolveBvid, parsePageArg, selectVideoPart } from './_shared.js';

export default defineAdapter({
  description: 'Metadata for a Bilibili video: title, author, duration, stats, payment gating. Accepts a BV id, video URL, or b23.tv short link.',
  access: 'read',
  domain: 'bilibili.com',
  args: [
    { name: 'bvid', type: 'string', required: true, help: 'BV id, video URL, or b23.tv short link' },
    { name: 'page', type: 'int', help: 'Multi-part (分P) selection, 1-based. Returns that part\'s title/cid/duration. Omit for the whole video (P1).' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const selectedPage = parsePageArg(args.page);
    const input = String(args.bvid ?? '').trim();
    const urlMatch = input.match(/bilibili\.com\/(?:video|bangumi\/play)\/(BV[A-Za-z0-9]+)/i);
    const bvid = urlMatch ? urlMatch[1] : await resolveBvid(input);

    const d = await biliApi(tab, '/x/web-interface/view', { bvid });
    const stat = d.stat || {};
    const owner = d.owner || {};
    const rights = d.rights || {};

    const flag = (v) => (typeof v === 'number' ? v !== 0 : Boolean(v));
    const paymentType = flag(rights.pay) ? 'vip'
      : (flag(rights.ugc_pay) || flag(rights.arc_pay)) ? 'ugc_pay'
        : flag(d.is_upower_exclusive) ? 'upower' : '';
    const payPreview = flag(rights.ugc_pay_preview) || flag(d.is_upower_preview);

    let title = d.title ?? '';
    let cid = d.cid ?? '';
    let dur = d.duration || 0;
    if (selectedPage != null) {
      const part = selectVideoPart(d, selectedPage);
      cid = part.cid ?? '';
      const partTitle = typeof part.part === 'string' ? part.part.trim() : '';
      title = partTitle || `${d.title ?? ''} P${selectedPage}`;
      if (Number(part.duration) > 0) dur = Number(part.duration);
    }

    const out = {
      bvid: d.bvid ?? '',
      aid: d.aid ?? '',
      title,
      author: owner.name ?? '',
      mid: owner.mid ?? '',
      category: d.tname_v2 || d.tname || '',
      published: d.pubdate ? new Date(d.pubdate * 1000).toISOString() : '',
      duration_s: dur,
      views: stat.view ?? 0,
      danmaku: stat.danmaku ?? 0,
      comments: stat.reply ?? 0,
      likes: stat.like ?? 0,
      coins: stat.coin ?? 0,
      favorites: stat.favorite ?? 0,
      shares: stat.share ?? 0,
      parts: d.videos ?? 1,
      thumbnail: d.pic ?? '',
      description: d.desc ?? '',
      requires_payment: Boolean(paymentType),
      payment_type: paymentType,
      pay_preview: payPreview,
      redirect_url: d.redirect_url ?? '',
      url: `https://www.bilibili.com/video/${d.bvid ?? bvid}`,
    };
    if (selectedPage != null) { out.page = selectedPage; out.cid = cid; out.series_title = d.title ?? ''; }
    if (!out.bvid) throw errors.empty('Video not found');
    return [out];
  },
});
