import { errors } from 'browsermcp/adapter-sdk';
import { facebookGraphql } from './_graphql.js';

const HOME = 'https://www.facebook.com/';

export async function ensureMarketplace(tab, path) {
  await tab.goto(`https://www.facebook.com/marketplace/${path}`, { waitUntil: 'load' });
  const url = await tab.url();
  if (/\/marketplace\/ineligible\//.test(url || '')) {
    throw errors.auth('Facebook Marketplace is unavailable for this account',
      'Sign in with a Facebook account that can access Marketplace.');
  }
  if (!url?.startsWith('https://www.facebook.com/marketplace/')) {
    throw errors.auth('Facebook Marketplace did not open in the signed-in session');
  }
}

export async function marketplaceQuery(tab, name, docId, variables) {
  return facebookGraphql(tab, HOME, name, variables, { docId });
}

export function textOf(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value && typeof value === 'object') {
    for (const field of ['text', 'formatted_amount', 'display_amount', 'amount', 'name', 'title']) {
      const result = textOf(value[field]);
      if (result) return result;
    }
  }
  return '';
}
