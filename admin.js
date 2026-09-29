/**
 * Admin panel – web UI to manage alert chats, allowed users, blocked accounts, chat clearing,
 * bot token, functions (APIs with master/own keys, commands, monitors), and view logs.
 * Built on Node's http module (no extra dependencies). Login with user ID + password
 * (ADMIN_USER / ADMIN_PASSWORD) creates a session cookie.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const logger = require('./logger');

const LISTS = new Set(['alertChats', 'allowedUsers']);
const PANEL_PAGE = path.join(__dirname, 'admin.html');
const LOGIN_PAGE = path.join(__dirname, 'login.html');

const COOKIE = 'admin_session';
const SESSION_TTL_MS = 12 * 3600 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const sessions = new Map();      // token -> { user, expires }
const failedLogins = new Map();  // ip -> { count, until }

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function page(res, file) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
  res.end(fs.readFileSync(file));
}

function redirect(res, to) {
  res.writeHead(302, { Location: to });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); } // 1 MB – room for long keys/tokens
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getSession(req) {
  const token = parseCookies(req)[COOKIE];
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return { token, ...s };
}

// Best-effort: look up a chat/user title from Telegram so entries get a readable label
async function lookupLabel(bot, id) {
  if (!bot) return '';
  try {
    const c = await Promise.race([bot.getChat(id), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
    return c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || (c.username ? '@' + c.username : '');
  } catch {
    return '';
  }
}

function startAdmin({ port, host, user, password, trustProxy, getBot, access, runBalanceCheck, sendTest, chats, settings, functions }) {
  if (!password) {
    console.warn('ADMIN_PASSWORD not set – admin panel disabled');
    return null;
  }

  const clientIp = (req) =>
    (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
  const isHttps = (req) => req.socket.encrypted || (trustProxy && req.headers['x-forwarded-proto'] === 'https');

  const sessionCookie = (req, token, maxAgeSec) =>
    `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;

  async function login(req, res) {
    const ip = clientIp(req);
    const f = failedLogins.get(ip);
    if (f?.until > Date.now()) {
      const mins = Math.ceil((f.until - Date.now()) / 60000);
      return json(res, 429, { error: `Too many failed attempts. Try again in ${mins} min.` });
    }

    const body = await readBody(req);
    const okUser = safeEqual(String(body.username || ''), user);
    const okPass = safeEqual(String(body.password || ''), password);
    if (!(okUser && okPass)) {
      const count = (f?.count || 0) + 1;
      failedLogins.set(ip, count >= MAX_FAILED_LOGINS ? { count: 0, until: Date.now() + LOCKOUT_MS } : { count, until: 0 });
      console.warn(`[ADMIN] failed login for "${String(body.username || '').slice(0, 50)}" from ${ip}`);
      return json(res, 401, { error: 'Invalid user ID or password' });
    }

    failedLogins.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { user, expires: Date.now() + SESSION_TTL_MS });
    console.log(`[ADMIN] ${user} logged in from ${ip}`);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, SESSION_TTL_MS / 1000) });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const session = getSession(req);

      // Writes require a JSON content type – blocks simple cross-site form posts
      if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
        return json(res, 415, { error: 'Content-Type must be application/json' });
      }

      // --- public routes ---
      if (req.method === 'GET' && url.pathname === '/login') return session ? redirect(res, '/') : page(res, LOGIN_PAGE);
      if (req.method === 'POST' && url.pathname === '/api/login') return await login(req, res);

      // --- everything below needs a session ---
      if (!session) {
        if (parts[0] === 'api') return json(res, 401, { error: 'Not logged in' });
        return redirect(res, '/login');
      }

      if (req.method === 'GET' && url.pathname === '/') return page(res, PANEL_PAGE);
      if (parts[0] !== 'api') return json(res, 404, { error: 'Not found' });

      // POST /api/logout
      if (req.method === 'POST' && parts[1] === 'logout') {
        sessions.delete(session.token);
        console.log(`[ADMIN] ${session.user} logged out`);
        return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
      }

      // GET /api/me
      if (req.method === 'GET' && parts[1] === 'me') return json(res, 200, { user: session.user });

      // GET /api/access
      if (req.method === 'GET' && parts[1] === 'access' && parts.length === 2) {
        return json(res, 200, access.snapshot());
      }

      // GET /api/logs?after=&level=&q=&limit=
      if (req.method === 'GET' && parts[1] === 'logs') {
        const p = url.searchParams;
        return json(res, 200, logger.query({
          after: Number(p.get('after')) || 0,
          level: p.get('level') || '',
          q: p.get('q') || '',
          limit: Math.min(Number(p.get('limit')) || 500, 2000),
        }));
      }

      // POST /api/lists/:list  { id, label }
      if (req.method === 'POST' && parts[1] === 'lists' && LISTS.has(parts[2]) && parts.length === 3) {
        const body = await readBody(req);
        const id = String(body.id || '').trim();
        const label = String(body.label || '').trim() || (await lookupLabel(getBot(), id));
        const entry = access.add(parts[2], id, label);
        console.log(`[ADMIN] ${session.user} added ${id}${entry.label ? ` (${entry.label})` : ''} to ${parts[2]}`);
        return json(res, 201, entry);
      }

      // DELETE /api/lists/:list/:id
      if (req.method === 'DELETE' && parts[1] === 'lists' && LISTS.has(parts[2]) && parts.length === 4) {
        access.remove(parts[2], parts[3]);
        console.log(`[ADMIN] ${session.user} removed ${parts[3]} from ${parts[2]}`);
        return json(res, 200, { ok: true });
      }

      // POST /api/test/:chatId  – send a test message to a chat
      if (req.method === 'POST' && parts[1] === 'test' && parts.length === 3) {
        await sendTest(parts[2]);
        console.log(`[ADMIN] ${session.user} sent test message to ${parts[2]}`);
        return json(res, 200, { ok: true });
      }

      // GET /api/accounts  – all accounts from the last balance check + blocked list + settings
      if (req.method === 'GET' && parts[1] === 'accounts' && parts.length === 2) {
        const snap = access.snapshot();
        return json(res, 200, { ...access.accounts(), blocked: snap.blockedAccounts, settings: snap.settings });
      }

      // POST /api/blocked  { id, accountId, accountNumber, label, bankName }
      if (req.method === 'POST' && parts[1] === 'blocked' && parts.length === 2) {
        const entry = access.blockAccount(await readBody(req));
        console.log(`[ADMIN] ${session.user} blocked account ${entry.id}${entry.label ? ` (${entry.label})` : ''}`);
        return json(res, 201, entry);
      }

      // DELETE /api/blocked/:id
      if (req.method === 'DELETE' && parts[1] === 'blocked' && parts.length === 3) {
        access.unblockAccount(parts[2]);
        console.log(`[ADMIN] ${session.user} unblocked account ${parts[2]}`);
        return json(res, 200, { ok: true });
      }

      // POST /api/settings  { skipInactive }
      if (req.method === 'POST' && parts[1] === 'settings' && parts.length === 2) {
        const settings = access.setSettings(await readBody(req));
        console.log(`[ADMIN] ${session.user} set skipInactive=${settings.skipInactive}`);
        return json(res, 200, settings);
      }

      // POST /api/check-balances  – run the balance check now
      if (req.method === 'POST' && parts[1] === 'check-balances' && parts.length === 2) {
        console.log(`[ADMIN] ${session.user} triggered a balance check`);
        await runBalanceCheck();
        return json(res, 200, { ok: true });
      }

      // --- chats ---
      // GET /api/chats
      if (req.method === 'GET' && parts[1] === 'chats' && parts.length === 2) return json(res, 200, chats.view());

      // POST /api/chats/clear  { chatId? }  – no chatId = all chats
      if (req.method === 'POST' && parts[1] === 'chats' && parts[2] === 'clear' && parts.length === 3) {
        const { chatId } = await readBody(req);
        console.log(`[ADMIN] ${session.user} cleared ${chatId ? `chat ${chatId}` : 'all chats'}`);
        return json(res, 200, await chats.clear(chatId ? String(chatId) : undefined));
      }

      // POST /api/chats/auto-clear  { enabled, mode, time, olderThanHours }
      if (req.method === 'POST' && parts[1] === 'chats' && parts[2] === 'auto-clear' && parts.length === 3) {
        const ac = chats.setAutoClear(await readBody(req));
        console.log(`[ADMIN] ${session.user} set auto-clear: ${ac.enabled ? `${ac.mode === 'daily' ? `daily at ${ac.time}` : 'continuous'}, older than ${ac.olderThanHours}h` : 'off'}`);
        return json(res, 200, ac);
      }

      // --- settings (bot token) ---
      if (parts[1] === 'settings') {
        // GET /api/settings
        if (req.method === 'GET' && parts.length === 2) return json(res, 200, settings.view());

        // POST /api/settings/bot-token  { token }
        if (req.method === 'POST' && parts[2] === 'bot-token' && parts.length === 3) {
          const { token } = await readBody(req);
          const info = await settings.setBotToken(token);
          console.log(`[ADMIN] ${session.user} changed the Telegram bot token (now @${info?.username})`);
          return json(res, 200, { ok: true, bot: info });
        }
      }

      // --- functions (each with a master key and APIs) ---
      if (parts[1] === 'functions') {
        const [, , fnId, sub, apiId, action] = parts;

        // GET /api/functions
        if (req.method === 'GET' && parts.length === 2) return json(res, 200, functions.view());

        // POST /api/functions  { id?, name, command, description, enabled, master, monitor, format }
        if (req.method === 'POST' && parts.length === 2) {
          const body = await readBody(req);
          const id = functions.upsert(body);
          console.log(`[ADMIN] ${session.user} ${body.id ? 'updated' : 'created'} function "${String(body.name || '').slice(0, 60)}"`);
          return json(res, 200, { ok: true, id });
        }

        // DELETE /api/functions/:id
        if (req.method === 'DELETE' && parts.length === 3) {
          functions.remove(fnId);
          console.log(`[ADMIN] ${session.user} deleted function ${fnId}`);
          return json(res, 200, { ok: true });
        }

        // POST /api/functions/:id/run  – run the monitor now
        if (req.method === 'POST' && sub === 'run' && parts.length === 4) {
          console.log(`[ADMIN] ${session.user} ran function ${fnId}`);
          await functions.runNow(fnId);
          return json(res, 200, { ok: true });
        }

        // POST /api/functions/:id/apis  { id?, name, url, keyMode, key, secret, ... }
        if (req.method === 'POST' && sub === 'apis' && parts.length === 4) {
          const body = await readBody(req);
          const id = functions.upsertApi(fnId, body);
          console.log(`[ADMIN] ${session.user} ${body.id ? 'updated' : 'added'} API "${String(body.name || '').slice(0, 60)}" in function ${fnId}`);
          return json(res, 200, { ok: true, id });
        }

        // DELETE /api/functions/:id/apis/:apiId
        if (req.method === 'DELETE' && sub === 'apis' && parts.length === 5) {
          functions.removeApi(fnId, apiId);
          console.log(`[ADMIN] ${session.user} deleted API ${apiId} from function ${fnId}`);
          return json(res, 200, { ok: true });
        }

        // POST /api/functions/:id/apis/:apiId/test
        if (req.method === 'POST' && sub === 'apis' && action === 'test' && parts.length === 6) {
          try {
            return json(res, 200, { ok: true, ...(await functions.testApi(fnId, apiId)) });
          } catch (e) {
            const status = e.response?.status;
            return json(res, 200, { ok: false, error: status ? `HTTP ${status}: ${e.message}` : e.message });
          }
        }
      }

      // DELETE /api/requests/:userId
      if (req.method === 'DELETE' && parts[1] === 'requests' && parts.length === 3) {
        access.dismissRequest(parts[2]);
        console.log(`[ADMIN] ${session.user} dismissed access request from ${parts[2]}`);
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: 'Not found' });
    } catch (e) {
      return json(res, 400, { error: e.response?.body?.description || e.message });
    }
  });

  // drop expired sessions / lockouts
  setInterval(() => {
    const now = Date.now();
    for (const [t, s] of sessions) if (s.expires < now) sessions.delete(t);
    for (const [ip, f] of failedLogins) if (f.until < now) failedLogins.delete(ip);
  }, 10 * 60 * 1000).unref();

  server.on('error', (e) => console.error('Admin panel error:', e.message));
  server.listen(port, host, () => console.log(`🔐 Admin panel on http://${host}:${port}`));
  return server;
}

module.exports = { startAdmin };
