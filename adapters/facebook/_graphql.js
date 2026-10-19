import { errors } from 'browsermcp/adapter-sdk';

export async function facebookGraphql(tab, pageUrl, operation, variables, { allowPartial = false, docId } = {}) {
  if (!/^https:\/\/www\.facebook\.com\/[\w/?=&%.-]*$/.test(pageUrl) || !/^[A-Za-z0-9_]+$/.test(operation)) {
    throw errors.argument('Invalid Facebook GraphQL request');
  }
  await tab.goto(pageUrl, { waitUntil: 'load' });
  await tab.network.start('/api/graphql/');
  const before = (await tab.network.read({ pattern: '/api/graphql/', limit: 1000 })).cursor;
  const url = new URL(pageUrl);
  url.searchParams.set('opencli_probe', String(Date.now()));
  await tab.goto(url.href, { waitUntil: 'load' });
  let entry;
  let cursor = before;
  for (let attempt = 0; attempt < 24 && !entry; attempt++) {
    const page = await tab.network.read({ pattern: '/api/graphql/', afterSequence: cursor, limit: 100 });
    cursor = page.cursor;
    entry = page.entries.find((item) => item.method === 'POST' && !item.requestBodyTruncated && item.requestBodyPreview);
    if (!entry) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!entry) throw errors.upstream('Facebook did not issue a GraphQL request for session bootstrap');
  const form = new URLSearchParams(entry.requestBodyPreview);
  const identity = await tab.evaluate(`(() => {
    let provided = {};
    try {
      const query = require('${operation}.graphql');
      provided = Object.fromEntries(Object.entries(query.params.providedVariables || {})
        .map(([key, value]) => [key, value.get()]));
    } catch {}
    let id;
    try { id = require('${operation}_facebookRelayOperation'); } catch { id = null; }
    return { id, provided };
  })()`);
  const id = identity?.id || docId;
  if (!/^\d+$/.test(String(id || ''))) throw errors.upstream(`Facebook did not load ${operation}`);
  form.set('fb_api_req_friendly_name', operation);
  form.set('doc_id', id);
  form.set('variables', JSON.stringify({ ...identity.provided, ...variables }));
  const response = await tab.evaluate(`(async () => {
    const response = await fetch('/api/graphql/', { method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: ${JSON.stringify(form.toString())} });
    if (!response.ok) return { httpError: response.status };
    const text = await response.text();
    try { return JSON.parse(text.split(String.fromCharCode(10))[0].replace(/^for\\s*\\(;;\\);/, '')); }
    catch { return { malformed: true }; }
  })()`);
  if (response?.httpError) throw errors.upstream(`Facebook GraphQL returned HTTP ${response.httpError}`);
  if (response?.malformed) throw errors.upstream('Facebook GraphQL returned malformed JSON');
  if (response?.errors?.length && !allowPartial) throw errors.upstream(`Facebook GraphQL: ${String(response.errors[0]?.message || 'query failed')}`);
  return response;
}
