import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { facebookGraphql } from './_graphql.js';

export function mapMemories(response, limit) {
  const connection = response?.data?.viewer?.throwback?.throwback_units;
  if (!Array.isArray(connection?.edges)) throw errors.upstream('Facebook memories response changed shape');
  const rows = connection.edges.slice(0, limit).flatMap(({ node }) => {
    if (!node) return [];
    const story = node.feedback?.story || node.story || {};
    const source = String(node.names_text?.text || story.actors?.[0]?.name || '').trim();
    const content = String(story.message?.text || node.message?.text || node.date_text?.text || '').trim();
    const time = String(node.date_text?.text || story.creation_time || '').trim();
    if (!source && !content) return [];
    return [{ index: 0, source, content, time }];
  });
  return { rows: rows.map((row, index) => ({ ...row, index: index + 1 })), pageInfo: connection.page_info };
}

export default defineAdapter({
  description: 'Read Facebook On This Day memories through CometMemoriesFeedQuery.',
  access: 'read', domain: 'facebook.com',
  result: { kind: 'rows', description: 'Memories', paginated: true },
  args: [
    { name: 'limit', type: 'int', default: 10, min: 1, max: 50 },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous page' },
  ],
  async run({ tab, args }) {
    const limit = Number(args.limit ?? 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw errors.argument('limit must be 1–50');
    const variables = { count: limit, cursor: args.cursor || null, feedbackSource: 0,
      feedLocation: 'GOODWILL_THROWBACK_PERMALINK', focusCommentID: null,
      goodwillTimestamp: null, privacySelectorRenderLocation: 'COMET_STREAM',
      renderLocation: 'throwback_composer', scale: 1, useDefaultActor: false };
    const response = await facebookGraphql(tab, 'https://www.facebook.com/memories/', 'CometMemoriesFeedQuery', variables);
    const { rows, pageInfo } = mapMemories(response, limit);
    return { rows, ...(pageInfo?.has_next_page && pageInfo?.end_cursor ? { nextCursor: pageInfo.end_cursor } : {}) };
  },
});
