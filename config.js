/**
 * Bot configuration managed from the admin panel:
 * - Telegram bot token
 * - API credentials (key/secret sets – as many as needed)
 * - API endpoints (balance / transactions), each using one of the credentials
 * - Chat auto-clear schedule
 * Stored in CONFIG_FILE. Seeded from .env on first run.
 */
const fs = require('fs');
const crypto = require('crypto');

const newId = () => crypto.randomBytes(4).toString('hex');
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const HEADER_RE = /^[A-Za-z0-9-]{0,60}$/;
const ENDPOINT_TYPES = ['balance', 'transactions'];

function mask(s) {
  s = String(s || '');
  if (!s) return '';
  return s.length <= 8 ? '••••' : `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

function maskToken(t) {
  t = String(t || '');
  if (!t) return '';
  const [botId] = t.split(':');
  return `${botId}:••••${t.slice(-4)}`;
}

function seedFromEnv(env) {
  const credentials = [];
  const endpoints = [];
  if (env.TREXO_KEY || env.TREXO_SECRET) {
    credentials.push({
      id: 'default', name: 'Default',
      key: env.TREXO_KEY || '', secret: env.TREXO_SECRET || '',
      keyHeader: 'x-trexo-key', secretHeader: 'x-trexo-secret',
    });
  }
  const credentialId = credentials[0]?.id || '';
  if (env.BALANCE_API_URL) {
    endpoints.push({ id: 'balance', name: 'Balances', type: 'balance', url: env.BALANCE_API_URL, credentialId, enabled: true, sinceParam: '' });
  }
  if (env.TXN_API_URL) {
    endpoints.push({ id: 'transactions', name: 'Transactions', type: 'transactions', url: env.TXN_API_URL, credentialId, enabled: true, sinceParam: env.TXN_SINCE_PARAM ?? 'from' });
  }
  return {
    telegram: { botToken: env.TELEGRAM_BOT_TOKEN || '' },
    credentials,
    endpoints,
    autoClear: { enabled: true, mode: 'rolling', time: '03:00', olderThanHours: 24 },
  };
}

function createConfigStore({ file, env, writeJson }) {
  let config = seedFromEnv(env);
  try {
    if (fs.existsSync(file)) config = { ...config, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    console.error('Could not read config file, using .env values:', e.message);
  }

  const save = () => {
    try { writeJson(file, config); } catch (e) { console.error('Failed to save config file:', e.message); }
  };
  save();

  const text = (v, max, field) => {
    const s = String(v ?? '').trim();
    if (s.length > max) throw new Error(`${field} is too long`);
    return s;
  };

  return {
    get: () => config,

    credentialFor: (endpoint) => config.credentials.find((c) => c.id === endpoint.credentialId) || null,

    // every secret value, so the logger can mask them
    secrets: () => [config.telegram.botToken, ...config.credentials.flatMap((c) => [c.key, c.secret])],

    // safe to send to the browser: secrets masked
    publicView: () => ({
      telegram: { configured: !!config.telegram.botToken, tokenHint: maskToken(config.telegram.botToken) },
      credentials: config.credentials.map((c) => ({
        id: c.id, name: c.name, keyHeader: c.keyHeader, secretHeader: c.secretHeader,
        keyHint: mask(c.key), secretHint: mask(c.secret),
        usedBy: config.endpoints.filter((e) => e.credentialId === c.id).map((e) => e.name),
      })),
      endpoints: config.endpoints,
      autoClear: config.autoClear,
    }),

    setBotToken(token) {
      token = String(token || '').trim();
      if (!/^\d{5,20}:[A-Za-z0-9_-]{30,60}$/.test(token)) throw new Error('That does not look like a Telegram bot token (123456:ABC…)');
      config.telegram = { ...config.telegram, botToken: token };
      save();
    },

    // create when no id; blank key/secret on update keeps the stored value
    upsertCredential(data) {
      const existing = data.id ? config.credentials.find((c) => c.id === data.id) : null;
      if (data.id && !existing) throw new Error('Credential not found');
      const name = text(data.name, 60, 'Name');
      if (!name) throw new Error('Name is required');
      const keyHeader = text(data.keyHeader ?? 'x-trexo-key', 60, 'Key header');
      const secretHeader = text(data.secretHeader ?? 'x-trexo-secret', 60, 'Secret header');
      if (!HEADER_RE.test(keyHeader) || !HEADER_RE.test(secretHeader)) throw new Error('Header names may only contain letters, digits and -');
      const key = text(data.key, 500, 'Key') || existing?.key || '';
      const secret = text(data.secret, 500, 'Secret') || existing?.secret || '';
      if (!key && !secret) throw new Error('Enter a key and/or secret');

      const entry = { id: existing?.id || newId(), name, key, secret, keyHeader, secretHeader };
      if (existing) Object.assign(existing, entry);
      else config.credentials.push(entry);
      save();
      return entry.id;
    },

    deleteCredential(id) {
      const users = config.endpoints.filter((e) => e.credentialId === id);
      if (users.length) throw new Error(`Still used by: ${users.map((e) => e.name).join(', ')}`);
      const before = config.credentials.length;
      config.credentials = config.credentials.filter((c) => c.id !== id);
      if (config.credentials.length === before) throw new Error('Credential not found');
      save();
    },

    upsertEndpoint(data) {
      const existing = data.id ? config.endpoints.find((e) => e.id === data.id) : null;
      if (data.id && !existing) throw new Error('API not found');
      const name = text(data.name, 60, 'Name');
      if (!name) throw new Error('Name is required');
      if (!ENDPOINT_TYPES.includes(data.type)) throw new Error('Type must be balance or transactions');
      const url = text(data.url, 500, 'URL');
      let parsed;
      try { parsed = new URL(url); } catch { throw new Error('Enter a valid URL'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('URL must start with http:// or https://');
      const credentialId = String(data.credentialId || '');
      if (credentialId && !config.credentials.some((c) => c.id === credentialId)) throw new Error('Choose a valid credential');
      const sinceParam = text(data.sinceParam, 40, 'Since parameter');
      if (!/^[A-Za-z0-9_.-]*$/.test(sinceParam)) throw new Error('Invalid since parameter name');

      const entry = {
        id: existing?.id || newId(), name, type: data.type, url, credentialId,
        enabled: data.enabled !== false,
        sinceParam: data.type === 'transactions' ? sinceParam : '',
      };
      if (existing) Object.assign(existing, entry);
      else config.endpoints.push(entry);
      save();
      return entry.id;
    },

    deleteEndpoint(id) {
      const before = config.endpoints.length;
      config.endpoints = config.endpoints.filter((e) => e.id !== id);
      if (config.endpoints.length === before) throw new Error('API not found');
      save();
    },

    setAutoClear({ enabled, mode, time, olderThanHours }) {
      if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
      if (!['rolling', 'daily'].includes(mode)) throw new Error('Mode must be rolling or daily');
      if (!TIME_RE.test(String(time))) throw new Error('Time must be HH:MM (24-hour)');
      const hours = Number(olderThanHours);
      const min = mode === 'rolling' ? 1 : 0;
      // Telegram refuses to delete messages older than 48 hours
      if (!Number.isInteger(hours) || hours < min || hours > 47) throw new Error(`Hours must be a whole number from ${min} to 47`);
      config.autoClear = { enabled, mode, time, olderThanHours: hours };
      save();
      return config.autoClear;
    },
  };
}

module.exports = { createConfigStore };
