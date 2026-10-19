import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureOnX, gql, apiError } from './_shared.js';

const QUERY_ID = '7xflPyRiUxGVbJd4uWmbfg';
const FEATURES = {
  longform_notetweets_consumption_enabled: true, responsive_web_twitter_article_tweet_consumption_enabled: true,
  longform_notetweets_rich_text_read_enabled: true, longform_notetweets_inline_media_enabled: true,
  articles_preview_enabled: true, responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false,
};
const FIELD_TOGGLES = { withArticleRichContentState: true, withArticlePlainText: true };

function articleToMarkdown(articleResults, legacy) {
  const title = articleResults.title || '(Untitled)';
  const contentState = articleResults.content_state || {};
  const blocks = Array.isArray(contentState.blocks) ? contentState.blocks : [];
  const rawEntityMap = contentState.entityMap || {};
  const entityByKey = {};
  if (Array.isArray(rawEntityMap)) { for (const e of rawEntityMap) if (e && e.key != null && e.value) entityByKey[String(e.key)] = e.value; }
  else { for (const [k, e] of Object.entries(rawEntityMap)) entityByKey[String(k)] = e?.value || e; }
  const mediaUrlById = {};
  for (const me of Object.values(articleResults.media_entities || {})) {
    const u = me?.media_info?.original_img_url;
    if (typeof u === 'string' && me?.media_id != null) mediaUrlById[String(me.media_id)] = u;
  }
  const parts = [];
  let ordered = 0;
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const type = block.type || 'unstyled';
    if (type === 'atomic') {
      const key = block.entityRanges?.[0]?.key;
      const entity = key == null ? null : entityByKey[String(key)];
      if (entity?.type === 'MEDIA') {
        const mediaId = entity.data?.mediaItems?.[0]?.mediaId;
        const img = mediaId == null ? null : mediaUrlById[String(mediaId)];
        const caption = String(entity.data?.caption || 'Image').replaceAll(']', '&#93;');
        if (img) parts.push(`![${caption}](${img})`);
      }
      continue;
    }
    const text = block.text || '';
    if (!text) continue;
    if (type !== 'ordered-list-item') ordered = 0;
    if (type === 'header-one') parts.push(`# ${text}`);
    else if (type === 'header-two') parts.push(`## ${text}`);
    else if (type === 'header-three') parts.push(`### ${text}`);
    else if (type === 'blockquote') parts.push(`> ${text}`);
    else if (type === 'unordered-list-item') parts.push(`- ${text}`);
    else if (type === 'ordered-list-item') { ordered++; parts.push(`${ordered}. ${text}`); }
    else if (type === 'code-block') parts.push('```\n' + text + '\n```');
    else parts.push(text);
  }
  return { title, content: parts.join('\n\n') || legacy.full_text || '' };
}

export default defineAdapter({
  description: 'Fetch an X Article (long-form post) and return it as Markdown.',
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'tweet_id', type: 'string', required: true, help: 'Tweet ID, status URL, or an /i/article/<id> URL containing the article' },
  ],
  async run({ tab, args }) {
    await ensureOnX(tab);
    let raw = String(args.tweet_id || '').trim();
    let tweetId;
    if (/\/article\/\d+/.test(raw)) {
      const articleId = raw.match(/\/article\/(\d+)/)[1];
      await tab.goto(`https://x.com/i/article/${articleId}`, { waitUntil: 'load', settleMs: 2500 });
      const resolved = await tab.evaluate(`(() => {
        for (const a of document.querySelectorAll('a[href*="/status/"]')) { const m = a.href.match(/\\/status\\/(\\d+)/); if (m) return m[1]; }
        const og = document.querySelector('meta[property="og:url"]'); if (og && og.content) { const m = og.content.match(/\\/status\\/(\\d+)/); if (m) return m[1]; }
        return null;
      })()`);
      if (!resolved || typeof resolved !== 'string') throw errors.empty(`Could not resolve article ${articleId} to a tweet ID`);
      tweetId = resolved;
    } else {
      const m = raw.match(/\/status\/(\d+)/) || raw.match(/^(\d+)$/);
      if (!m) throw errors.argument('tweet_id must be a tweet id, status URL, or /i/article/<id> URL');
      tweetId = m[1];
    }
    let data;
    try {
      data = await gql(tab, QUERY_ID, 'TweetResultByRestId',
        { tweetId, withCommunity: false, includePromotedContent: false, withVoice: false },
        { features: FEATURES, fieldToggles: FIELD_TOGGLES });
    } catch (e) { throw apiError('TweetResultByRestId', e?.data?.status || e?.status || 0); }
    const result = data?.data?.tweetResult?.result;
    if (!result) throw errors.empty('Article not found');
    const tw = result.tweet || result;
    const legacy = tw.legacy || {};
    const user = tw.core?.user_results?.result;
    const author = user?.legacy?.screen_name || user?.core?.screen_name || '';
    const articleResults = tw.article?.article_results?.result;
    const url = `https://x.com/${author}/status/${tweetId}`;
    if (!articleResults) {
      const note = tw.note_tweet?.note_tweet_results?.result?.text;
      if (note) return { title: '(Note Tweet)', author, content: note, url };
      throw errors.empty(`Tweet ${tweetId} has no article content`);
    }
    const { title, content } = articleToMarkdown(articleResults, legacy);
    return { title, author, content, url };
  },
});
