import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnBili, biliApi, biliApiSigned, resolveBvid } from './_shared.js';

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function readModelResult(data, bvid) {
  // conclusion/get: the outer envelope is unwrapped already; `data.code` is the model-availability code.
  if (data?.code !== 0) throw errors.empty(`Bilibili has not generated an AI summary for ${bvid}.`);
  let modelResult = data.model_result;
  if (typeof modelResult === 'string') {
    try { modelResult = JSON.parse(modelResult); } catch { throw errors.upstream('Bilibili conclusion API returned malformed model_result JSON'); }
  }
  if (!modelResult || typeof modelResult !== 'object' || Array.isArray(modelResult)) throw errors.upstream('Bilibili conclusion API returned malformed model_result');
  const summary = String(modelResult.summary ?? '').trim();
  if (!summary) throw errors.empty(`Bilibili has not generated an AI summary for ${bvid}.`);
  const outline = Array.isArray(modelResult.outline) ? modelResult.outline : [];
  return { summary, outline };
}

function rowsFromModel(model) {
  const rows = [{ time: '', content: model.summary }];
  for (const section of model.outline) {
    if (!section || typeof section !== 'object') continue;
    const sectionTitle = String(section.title ?? '').trim();
    if (sectionTitle) rows.push({ time: formatTime(section.timestamp), content: `# ${sectionTitle}` });
    const points = Array.isArray(section.part_outline) ? section.part_outline : [];
    for (const point of points) {
      const content = String(point?.content ?? '').trim();
      if (content) rows.push({ time: formatTime(point.timestamp), content });
    }
  }
  return rows;
}

export default defineAdapter({
  description: 'The official AI-generated summary (AI总结) of a Bilibili video, with a timestamped outline. Accepts a BV id, URL, or b23.tv link.',
  access: 'read',
  domain: 'bilibili.com',
  args: [
    { name: 'bvid', type: 'string', required: true, help: 'BV id, video URL, or b23.tv short link' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const bvid = await resolveBvid(args.bvid);
    const viewData = await biliApi(tab, '/x/web-interface/view', { bvid });
    const cid = viewData?.cid;
    const upMid = viewData?.owner?.mid;
    if (!cid || !upMid) throw errors.upstream(`Bilibili view API did not return cid/up_mid for ${bvid}`);
    const conclusionData = await biliApiSigned(tab, '/x/web-interface/view/conclusion/get', { bvid, cid, up_mid: upMid });
    return rowsFromModel(readModelResult(conclusionData, bvid));
  },
});
