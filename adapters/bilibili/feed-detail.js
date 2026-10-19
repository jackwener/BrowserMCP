import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnBili, biliApi, stripHtml } from './_shared.js';

const TYPE_MAP = {
  DYNAMIC_TYPE_AV: 'video',
  DYNAMIC_TYPE_DRAW: 'draw',
  DYNAMIC_TYPE_ARTICLE: 'article',
  DYNAMIC_TYPE_FORWARD: 'forward',
  DYNAMIC_TYPE_WORD: 'text',
  DYNAMIC_TYPE_LIVE_RCMD: 'live',
  DYNAMIC_TYPE_PGC: 'bangumi',
};

export default defineAdapter({
  description: 'Full detail of a single Bilibili dynamic by its id (from a feed url), including charge-exclusive content.',
  access: 'read',
  domain: 'bilibili.com',
  args: [
    { name: 'id', type: 'string', required: true, help: 'Dynamic id (the number in a t.bilibili.com/<id> url)' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const id = String(args.id);
    const data = await biliApi(tab, '/x/polymer/web-dynamic/v1/detail', { id, timezone_offset: -480 });
    const item = data?.item;
    if (!item) throw errors.empty('Dynamic not found or not viewable');

    const modules = item.modules ?? {};
    const author = modules.module_author ?? {};
    const dynamicModule = modules.module_dynamic ?? {};
    const major = dynamicModule.major ?? {};
    const stat = modules.module_stat ?? {};

    const out = {
      id: item.id_str ?? id,
      author: author.name ?? '',
      time: author.pub_time ?? '',
      type: TYPE_MAP[item.type] ?? item.type ?? '',
      url: `https://t.bilibili.com/${item.id_str ?? id}`,
      likes: stat.like?.count ?? 0,
      comments: stat.comment?.count ?? 0,
      forwards: stat.forward?.count ?? 0,
    };
    if (dynamicModule.desc?.text) out.text = stripHtml(dynamicModule.desc.text);
    if (major.archive) {
      out.video_title = major.archive.title ?? '';
      out.video_desc = major.archive.desc ?? '';
      out.video_url = major.archive.jump_url ? `https:${major.archive.jump_url}` : '';
      out.play = major.archive.stat?.play ?? '';
      out.danmaku = major.archive.stat?.danmaku ?? '';
    }
    if (major.article) {
      out.article_title = major.article.title ?? '';
      out.article_url = major.article.jump_url ? `https:${major.article.jump_url}` : '';
    }
    if (major.draw?.items?.length) out.images = major.draw.items.map((img) => img.src);
    if (major.opus?.summary?.text) out.opus_text = stripHtml(major.opus.summary.text);
    if (major.opus?.title) out.opus_title = major.opus.title;
    if (item.orig) {
      out.forward_from = item.orig.modules?.module_author?.name ?? '';
      const origDesc = item.orig.modules?.module_dynamic?.desc?.text ?? '';
      if (origDesc) out.forward_text = stripHtml(origDesc).slice(0, 200);
    }
    return [out];
  },
});
