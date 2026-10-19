import { defineAdapter, errors } from 'browsermcp/adapter-sdk';
import { ensureLinkedIn, linkedinApi, requireElements } from './_shared.js';

export function mapPreferences(preferences, alerts) {
  if (!preferences || typeof preferences.sharedWithRecruiters !== 'boolean') {
    throw errors.upstream('LinkedIn job preferences API returned an invalid response');
  }
  if (!Array.isArray(alerts)) throw errors.upstream('LinkedIn job alerts API returned an invalid response');
  return {
    open_to_work: preferences.sharedWithRecruiters ? 'on' : 'off',
    job_titles: [], preferred_role_urns: preferences.preferredRolesUrns || [],
    locations: [], geo_urns: preferences.geoUrns || [],
    seeking_remote: Boolean(preferences.seekingRemote),
    job_alerts: alerts,
    job_recommendations_email: Boolean(preferences.jobRecommendationsEmailEnabled),
    job_recommendations_push: Boolean(preferences.jobRecommendationsPushNotificationsEnabled),
    preferences_url: 'https://www.linkedin.com/jobs/preferences/',
    alerts_url: 'https://www.linkedin.com/jobs/alerts/',
  };
}

export default defineAdapter({
  description: 'Read LinkedIn job preferences and alerts through the Voyager API.',
  access: 'read', domain: 'linkedin.com',
  result: { kind: 'rows', description: 'Job preferences' },
  args: [],
  async run({ tab }) {
    await ensureLinkedIn(tab);
    const preferences = await linkedinApi(tab, '/voyager/api/voyagerJobsDashJobSeekerPreferences');
    const alerts = requireElements(await linkedinApi(tab, '/voyager/api/voyagerJobsDashJobAlerts?count=100&start=0'), 'LinkedIn job alerts');
    return { rows: [mapPreferences(preferences, alerts)] };
  },
});
