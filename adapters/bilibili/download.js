import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnBili, biliApi, biliApiSigned, resolveBvid, parsePageArg, selectVideoPart } from './_shared.js';

const PAYMENT_LABELS = { vip: 'VIP/paid OGV', ugc_pay: 'paid UGC', upower: 'charge-exclusive' };
const QN_BY_QUALITY = { best: 127, '1080p': 80, '720p': 64, '480p': 32 };

/**
 * Paid-content pre-check. Paid/VIP videos only yield a preview stream (or none),
 * so surface a structured error before returning URLs. `force` skips the check.
 */
async function assertNotPaid(tab, viewData) {
  const rights = viewData?.rights || {};
  const flag = (v) => (typeof v === 'number' ? v !== 0 : Boolean(v));
  const paymentType = flag(rights.pay) ? 'vip'
    : (flag(rights.ugc_pay) || flag(rights.arc_pay)) ? 'ugc_pay'
      : flag(viewData?.is_upower_exclusive) ? 'upower' : '';
  if (!paymentType) return;
  if (paymentType === 'vip') {
    try {
      const nav = await tab.fetchJson('https://api.bilibili.com/x/web-interface/nav');
      if (nav?.code === 0 && Number(nav?.data?.vipStatus) === 1) return;
    } catch { /* treat nav failure as no membership */ }
  }
  throw errors.upstream(
    `This is paid content (${PAYMENT_LABELS[paymentType]}); the account has no viewing rights, so full streams are unavailable.`,
    'If you have purchased/charged/subscribed, pass force to skip this check.',
  );
}

export default defineAdapter({
  description: 'Get the direct media stream URLs for a Bilibili video (video + audio DASH streams, or a progressive URL). Returns URLs only; does not download files. Accepts a BV id, URL, or b23.tv link.',
  access: 'read',
  domain: 'bilibili.com',
  args: [
    { name: 'bvid', type: 'string', required: true, help: 'BV id, video URL, or b23.tv short link' },
    { name: 'quality', type: 'string', default: 'best', choices: ['best', '1080p', '720p', '480p'], help: 'Preferred max quality' },
    { name: 'force', type: 'boolean', default: false, help: 'Skip the paid-content pre-check (use if already purchased/charged/subscribed)' },
    { name: 'page', type: 'int', help: 'Multi-part (分P) selection, 1-based. Defaults to P1.' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const bvid = await resolveBvid(args.bvid);
    const selectedPage = parsePageArg(args.page);

    const viewData = await biliApi(tab, '/x/web-interface/view', { bvid });
    const cid = selectedPage != null ? selectVideoPart(viewData, selectedPage).cid : viewData?.cid;
    if (!cid) throw errors.upstream(`Could not resolve cid for bvid=${bvid}`);
    if (!args.force) await assertNotPaid(tab, viewData);

    const qn = QN_BY_QUALITY[args.quality] ?? 127;
    // fnval 4048 = DASH + 4K/HDR/8K flags; returns data.dash (or data.durl for progressive).
    const play = await biliApiSigned(tab, '/x/player/wbi/playurl', { bvid, cid, qn, fnval: 4048, fourk: 1 });

    const rows = [];
    const pageUrl = selectedPage != null
      ? `https://www.bilibili.com/video/${bvid}?p=${selectedPage}`
      : `https://www.bilibili.com/video/${bvid}`;

    if (play?.dash) {
      for (const v of play.dash.video || []) {
        rows.push({ kind: 'video', quality_id: v.id, codec: v.codecs || '', width: v.width, height: v.height, bandwidth: v.bandwidth, url: v.baseUrl || v.base_url, page_url: pageUrl });
      }
      for (const a of play.dash.audio || []) {
        rows.push({ kind: 'audio', quality_id: a.id, codec: a.codecs || '', bandwidth: a.bandwidth, url: a.baseUrl || a.base_url, page_url: pageUrl });
      }
    }
    for (const seg of play?.durl || []) {
      rows.push({ kind: 'progressive', quality_id: play.quality, url: seg.url, page_url: pageUrl });
    }
    if (!rows.length) throw errors.empty('No stream URLs returned (may be paid or region-locked content).');
    return rows;
  },
});
