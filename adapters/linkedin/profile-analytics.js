import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';
import { ensureLinkedIn, linkedinApi } from './_shared.js';
import { linkedinProfile, profileIdentity } from './_profile.js';

export function mapProfileAnalytics(views, appearances, connections, profile) {
  const cards = views?.elements?.[0]?.value?.['com.linkedin.voyager.identity.me.wvmpOverview.WvmpViewersCard']?.insightCards;
  const summary = cards?.find((card) => card?.value?.['com.linkedin.voyager.identity.me.wvmpOverview.WvmpSummaryInsightCard'])
    ?.value?.['com.linkedin.voyager.identity.me.wvmpOverview.WvmpSummaryInsightCard'];
  if (!summary || !Number.isFinite(summary.numViews) || !Number.isFinite(appearances?.metadata?.numAppearances)
    || !Number.isFinite(connections?.numConnections)) {
    throw errors.upstream('LinkedIn profile analytics response changed shape');
  }
  return {
    profile_url: `https://www.linkedin.com/in/${encodeURIComponent(profile.publicIdentifier)}/`,
    profile_views: summary.numViews,
    profile_views_period: summary.timeFrame || null,
    profile_views_change_percent: Number.isFinite(summary.numViewsChangeInPercentage) ? summary.numViewsChangeInPercentage : null,
    search_appearances: appearances.metadata.numAppearances,
    search_appearances_period: appearances.metadata.headerTitle || null,
    post_impressions: null,
    followers: null,
    connections: connections.numConnections,
  };
}

export default defineAdapter({
  description: 'Read owner profile views and search appearances from LinkedIn analytics APIs.',
  access: 'read', domain: 'linkedin.com',
  result: { kind: 'rows', description: 'LinkedIn profile analytics' },
  args: [{ name: 'profile_url', type: 'string', help: 'Your LinkedIn /in/<handle>/ URL; defaults to your profile' }],
  async run({ tab, args }) {
    const identity = profileIdentity(args.profile_url);
    await ensureLinkedIn(tab);
    const own = await linkedinProfile(tab, 'me');
    if (identity !== 'me' && identity !== own.publicIdentifier) {
      throw errors.argument('profile_analytics is available only for your own LinkedIn profile');
    }
    const views = await linkedinApi(tab, '/voyager/api/identity/wvmpCards?count=10&start=0');
    const appearances = await linkedinApi(tab, '/voyager/api/identity/searchAppearances?count=10&start=0');
    const connections = await linkedinApi(tab, '/voyager/api/relationships/connectionsSummary');
    return { rows: [mapProfileAnalytics(views, appearances, connections, own)] };
  },
});
