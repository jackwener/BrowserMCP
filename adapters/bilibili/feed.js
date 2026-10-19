import { defineAdapter } from '@jackwener/browsermcp/adapter-sdk';
import { ensureOnBili, biliApi, resolveUid, stripHtml } from './_shared.js';

const TYPE_MAP = {
  DYNAMIC_TYPE_AV: 'video',
  DYNAMIC_TYPE_DRAW: 'draw',
  DYNAMIC_TYPE_ARTICLE: 'article',
  DYNAMIC_TYPE_FORWARD: 'forward',
  DYNAMIC_TYPE_WORD: 'text',
  DYNAMIC_TYPE_LIVE_RCMD: 'live',
  DYNAMIC_TYPE_PGC: 'bangumi',
};

function parseItem(item) {
  const modules = item.modules ?? {};
  const authorModule = modules.module_author ?? {};
  const dynamicModule = modules.module_dynamic ?? {};
  const major = dynamicModule.major ?? {};
  const stat = modules.module_stat ?? {};
  let title = '';
  let url = item.id_str ? `https://t.bilibili.com/${item.id_str}` : '';
  const itemType = TYPE_MAP[item.type] ?? item.type ?? '';
  if (major.archive) {
    title = major.archive.title ?? '';
    url = major.archive.jump_url ? `https:${major.archive.jump_url}` : url;
  }
  if (!title && major.article) {
    title = major.article.title ?? '';
    url = major.article.jump_url ? `https:${major.article.jump_url}` : url;
  }
  if (!title && dynamicModule.desc?.text) title = stripHtml(dynamicModule.desc.text).slice(0, 60);
  if (!title && major.draw) {
    const imgCount = major.draw.items?.length ?? 0;
    title = imgCount > 0 ? `[图片x${imgCount}]` : '[图文动态]';
  }
  if (!title && item.basic?.is_only_fans) title = '[充电专属]';
  if (!title && item.type === 'DYNAMIC_TYPE_FORWARD') title = '[转发动态]';
  if (!title) title = `[${itemType || '动态'}]`;
  return {
    title, url, itemType, author: authorModule.name ?? '',
    time: authorModule.pub_time ?? '',
    likes: stat.like?.count ?? 0,
    comments: stat.comment?.count ?? 0,
  };
}

export default defineAdapter({
  description: 'Bilibili dynamic timeline. With no uid: your following timeline; with a uid/username: that user\'s posts (requires login).',
  access: 'read',
  domain: 'bilibili.com',
  args: [
    { name: 'uid', type: 'string', help: 'User uid or username; omit for your following timeline' },
    { name: 'limit', type: 'int', default: 20, help: 'Max results to return' },
    { name: 'type', type: 'string', default: 'all', help: 'Filter: all, video, article, draw, text' },
    { name: 'pages', type: 'int', default: 1, help: 'Number of pages to fetch (each ~20 items)' },
  ],
  async run({ tab, args }) {
    await ensureOnBili(tab);
    const maxResults = Number(args.limit) || 20;
    const maxPages = Number(args.pages) || 1;
    const filterType = args.type === 'all' ? '' : (args.type ?? '');
    const isUserFeed = !!args.uid;
    const uid = isUserFeed ? await resolveUid(tab, String(args.uid)) : null;

    const rows = [];
    let offset = '';
    for (let p = 0; p < maxPages; p++) {
      if (rows.length >= maxResults) break;
      let data;
      if (isUserFeed) {
        const params = { host_mid: uid, timezone_offset: -480 };
        if (offset) params.offset = offset;
        data = await biliApi(tab, '/x/polymer/web-dynamic/v1/feed/space', params);
      } else {
        const params = { timezone_offset: -480, type: filterType || 'all', page: p + 1 };
        if (offset) params.offset = offset;
        data = await biliApi(tab, '/x/polymer/web-dynamic/v1/feed/all', params);
      }
      const items = data?.items ?? [];
      if (items.length === 0) break;
      for (const item of items) {
        if (rows.length >= maxResults) break;
        const parsed = parseItem(item);
        if (filterType && parsed.itemType !== filterType) continue;
        rows.push({
          rank: rows.length + 1, time: parsed.time, author: parsed.author,
          title: parsed.title, type: parsed.itemType, likes: parsed.likes, url: parsed.url,
        });
      }
      offset = data.offset ?? items[items.length - 1]?.id_str ?? '';
      if (!offset || !data.has_more) break;
    }
    return rows;
  },
});
