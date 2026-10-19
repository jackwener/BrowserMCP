import { errors } from '@jackwener/browsermcp/adapter-sdk';

export const ORIGIN = 'https://discord.com';
const API = `${ORIGIN}/api/v9`;
const SNOWFLAKE = /^\d{17,20}$/;

export function count(value, label, fallback, max = 100) {
  const n = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw errors.argument(`${label} must be between 1 and ${max}`);
  return n;
}

export function discordRoute(value) {
  try {
    const url = new URL(value);
    if (url.origin !== ORIGIN) return null;
    const match = url.pathname.match(/^\/channels\/(\d{17,20}|@me)(?:\/(\d{17,20}))?(?:\/(\d{17,20}))?/);
    return match ? { guild: match[1], channel: match[2] || null, message: match[3] || null } : null;
  } catch { return null; }
}

function authHeader(headers) {
  return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
}

/** Obtain a fresh authorization header from the logged-in app's own API traffic. */
async function discordHeaders(tab) {
  const current = await tab.url().catch(() => null);
  const target = current?.startsWith(`${ORIGIN}/channels/`) ? current : `${ORIGIN}/channels/@me`;
  await tab.goto(target, { waitUntil: 'load' });
  await tab.network.start('/api/');
  const before = (await tab.network.read({ pattern: '/api/', limit: 1000 })).cursor;
  const url = new URL(target);
  url.searchParams.set('opencli_mcp_probe', String(Date.now()));
  await tab.goto(url.href, { waitUntil: 'load' });
  let cursor = before;
  let entry;
  for (let attempt = 0; attempt < 32 && !entry; attempt++) {
    const page = await tab.network.read({ pattern: '/api/', afterSequence: cursor, limit: 100 });
    cursor = page.cursor;
    entry = page.entries.find((item) => authHeader(item.requestHeaders));
    if (!entry) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!entry) throw errors.auth('Discord did not issue an authenticated API request', 'Open discord.com, sign in, and retry.');
  const authorization = authHeader(entry.requestHeaders);
  const properties = Object.entries(entry.requestHeaders).find(([key]) => key.toLowerCase() === 'x-super-properties')?.[1];
  return { authorization, ...(properties ? { 'x-super-properties': properties } : {}) };
}

export async function discordClient(tab) {
  const currentUrl = await tab.url().catch(() => null);
  const route = discordRoute(currentUrl);
  const headers = await discordHeaders(tab);
  const api = async (path, options = {}) => {
    if (!path.startsWith('/') || path.startsWith('//')) throw errors.argument('Discord API path must be relative');
    try { return await tab.fetchJson(`${API}${path}`, { ...options, headers: { ...headers, ...options.headers } }); }
    catch (cause) {
      const message = String(cause?.message || cause);
      if (/HTTP 401\b/.test(message)) throw errors.auth('Discord API rejected the session', 'Sign in to discord.com and retry.');
      if (/HTTP 403\b/.test(message)) throw errors.upstream('Discord API denied access to this resource');
      throw errors.upstream(`Discord API request failed: ${message}`);
    }
  };
  return { api, route };
}

export async function guildId(api, raw, route) {
  const value = String(raw || route?.guild || '').trim();
  if (SNOWFLAKE.test(value)) return value;
  if (!value || value === '@me') throw errors.argument('guild is required for this command');
  const guilds = await api('/users/@me/guilds');
  if (!Array.isArray(guilds)) throw errors.upstream('Discord guild list changed shape');
  const exact = guilds.find((guild) => guild.name?.toLowerCase() === value.toLowerCase());
  const partial = guilds.filter((guild) => guild.name?.toLowerCase().includes(value.toLowerCase()));
  const found = exact || (partial.length === 1 ? partial[0] : null);
  if (!found) throw errors.argument(`Discord guild not found or ambiguous: ${value}`);
  return found.id;
}

export async function channelId(api, args, route) {
  const fromUrl = args.url ? discordRoute(args.url) : null;
  if (args.url && !fromUrl) throw errors.argument('url must be a discord.com channel URL');
  const value = String(args.channel || fromUrl?.channel || route?.channel || '').trim();
  if (SNOWFLAKE.test(value)) return { channel: value, guild: String(args.guild || fromUrl?.guild || route?.guild || '') };
  if (!value) throw errors.argument('channel or url is required');
  const guild = await guildId(api, args.guild || fromUrl?.guild, route);
  const channels = await api(`/guilds/${guild}/channels`);
  if (!Array.isArray(channels)) throw errors.upstream('Discord channels API changed shape');
  const exact = channels.find((channel) => channel.name?.toLowerCase() === value.toLowerCase());
  const partial = channels.filter((channel) => channel.name?.toLowerCase().includes(value.toLowerCase()));
  const found = exact || (partial.length === 1 ? partial[0] : null);
  if (!found) throw errors.argument(`Discord channel not found or ambiguous: ${value}`);
  return { channel: found.id, guild };
}

export function messageRow(message) {
  if (!message?.id || !message?.channel_id) throw errors.upstream('Discord message changed shape');
  return {
    message_id: message.id,
    channel_id: message.channel_id,
    author_id: message.author?.id || null,
    author: message.author?.global_name || message.author?.username || null,
    content: String(message.content || ''),
    timestamp: message.timestamp || null,
    edited_timestamp: message.edited_timestamp || null,
    attachments: (message.attachments || []).map((item) => ({ id: item.id, filename: item.filename, size: item.size, url: item.url })),
  };
}

export function channelUrl(guild, channel, message = '') {
  return `${ORIGIN}/channels/${guild || '@me'}/${channel}${message ? `/${message}` : ''}`;
}
