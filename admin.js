/**
 * Admin panel – web UI to manage alert chats and allowed users.
 * Built on Node's http module (no extra dependencies), protected by HTTP Basic auth.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const LISTS = new Set(['alertChats', 'allowedUsers']);
const PAGE = path.join(__dirname, 'admin.html');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10000) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Best-effort: look up a chat/user title from Telegram so entries get a readable label
async function lookupLabel(bot, id) {
  try {
    const c = await Promise.race([bot.getChat(id), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
    return c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || (c.username ? '@' + c.username : '');
  } catch {
    return '';
  }
}

function startAdmin({ port, host, user, password, bot, access }) {
  if (!password) {
    console.warn('ADMIN_PASSWORD not set – admin panel disabled');
    return null;
  }

  const authorised = (req) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Basic' || !encoded) return false;
    const decoded = Buffer.from(encoded, 'base64').toString();
    const i = decoded.indexOf(':');
    // evaluate both so timing doesn't reveal which part was wrong
    const okUser = safeEqual(decoded.slice(0, i), user);
    const okPass = safeEqual(decoded.slice(i + 1), password);
    return i >= 0 && okUser && okPass;
  };

  const server = http.createServer(async (req, res) => {
    if (!authorised(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Bot Admin", charset="UTF-8"' });
      return res.end('Authentication required');
    }

    const url = new URL(req.url, 'http://local');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
        return res.end(fs.readFileSync(PAGE));
      }

      if (parts[0] !== 'api') return json(res, 404, { error: 'Not found' });

      // Writes require a JSON content type – blocks simple cross-site form posts
      if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
        return json(res, 415, { error: 'Content-Type must be application/json' });
      }

      // GET /api/access
      if (req.method === 'GET' && parts[1] === 'access' && parts.length === 2) {
        return json(res, 200, access.snapshot());
      }

      // POST /api/lists/:list  { id, label }
      if (req.method === 'POST' && parts[1] === 'lists' && LISTS.has(parts[2]) && parts.length === 3) {
        const body = await readBody(req);
        const id = String(body.id || '').trim();
        const label = String(body.label || '').trim() || (await lookupLabel(bot, id));
        const entry = access.add(parts[2], id, label);
        console.log(`[ADMIN] added ${id} to ${parts[2]}`);
        return json(res, 201, entry);
      }

      // DELETE /api/lists/:list/:id
      if (req.method === 'DELETE' && parts[1] === 'lists' && LISTS.has(parts[2]) && parts.length === 4) {
        access.remove(parts[2], parts[3]);
        console.log(`[ADMIN] removed ${parts[3]} from ${parts[2]}`);
        return json(res, 200, { ok: true });
      }

      // POST /api/test/:chatId  – send a test message to a chat
      if (req.method === 'POST' && parts[1] === 'test' && parts.length === 3) {
        await bot.sendMessage(parts[2], '✅ Test message from the monitoring bot admin panel.');
        return json(res, 200, { ok: true });
      }

      // DELETE /api/requests/:userId
      if (req.method === 'DELETE' && parts[1] === 'requests' && parts.length === 3) {
        access.dismissRequest(parts[2]);
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: 'Not found' });
    } catch (e) {
      return json(res, 400, { error: e.response?.body?.description || e.message });
    }
  });

  server.on('error', (e) => console.error('Admin panel error:', e.message));
  server.listen(port, host, () => console.log(`🔐 Admin panel on http://${host}:${port}`));
  return server;
}

module.exports = { startAdmin };
