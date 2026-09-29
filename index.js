/**
 * Internal Telegram Alert Bot
 * - Alerts when a customer has N+ consecutive failed transactions (default 3)
 * - Alerts when any account balance drops below threshold (default ₹30,00,000 = 30 Lakh)
 * - Sends recovery messages when things return to normal
 * - Alerts if your APIs stop responding
 * - Clears bot chats automatically (default: messages older than 24 hours)
 * Bot token, API keys and API URLs are managed from the admin panel.
 */
require('dotenv').config();
const path = require('path');
const logger = require('./logger');

// All data files live in DATA_DIR (e.g. a Railway volume at /data) unless overridden one by one
const dataDir = path.resolve(process.env.DATA_DIR || '.');
const dataFile = (envName, name) => path.resolve(process.env[envName] || path.join(dataDir, name));

logger.init({
  file: dataFile('LOG_FILE', 'logs.jsonl'),
  redact: [process.env.TELEGRAM_BOT_TOKEN, process.env.TREXO_KEY, process.env.TREXO_SECRET, process.env.ADMIN_PASSWORD],
});
const fs = require('fs');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { createConfigStore } = require('./config');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

const cfg = {
  alertChatIds: [],   // loaded from ACCESS_FILE below (managed via admin panel)
  allowedUserIds: [],

  skipInactive: (process.env.SKIP_INACTIVE_ACCOUNTS || 'true') === 'true',
  txnLookbackMin: Number(process.env.TXN_LOOKBACK_MINUTES || 30),

  balanceThreshold: Number(process.env.BALANCE_THRESHOLD || 3000000),
  balanceRemindMin: Number(process.env.BALANCE_REMIND_MINUTES || 60),
  failThreshold: Number(process.env.FAIL_THRESHOLD || 3),
  failRepeatEvery: Number(process.env.FAIL_REPEAT_EVERY || 5),
  apiErrorThreshold: Number(process.env.API_ERROR_THRESHOLD || 3),

  balancePollSec: Number(process.env.BALANCE_POLL_SECONDS || 300),
  txnPollSec: Number(process.env.TXN_POLL_SECONDS || 60),

  failedStatuses: new Set(list(process.env.FAILED_STATUSES || 'FAILED,FAILURE,DECLINED,REJECTED,ERROR').map((s) => s.toUpperCase())),
  successStatuses: new Set(list(process.env.SUCCESS_STATUSES || 'SUCCESS,SUCCESSFUL,COMPLETED,SETTLED').map((s) => s.toUpperCase())),

  timezone: process.env.TIMEZONE || 'Asia/Kolkata',
  stateFile: dataFile('STATE_FILE', 'state.json'),
};

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Bot token, API credentials, API endpoints, auto-clear – editable in the admin panel
const config = createConfigStore({ file: dataFile('CONFIG_FILE', 'config.json'), env: process.env, writeJson });
const refreshSecrets = () => logger.setSecrets([...config.secrets(), process.env.ADMIN_PASSWORD]);
refreshSecrets();

// ---------------------------------------------------------------------------
// API response mapping  <-- ADJUST THESE TO MATCH YOUR API FIELDS
// ---------------------------------------------------------------------------
function extractList(data) {
  if (Array.isArray(data)) return data;
  for (const k of ['data', 'transactions', 'accounts', 'items', 'result', 'records']) {
    if (Array.isArray(data?.[k])) return data[k];
    if (Array.isArray(data?.[k]?.items)) return data[k].items;
  }
  return [];
}

// Trexo /api/v1/accounts  ->  { data: [ { id, account_name, account_number, ledger_balance, ... } ] }
function mapBalance(r) {
  return {
    accountId: String(r.id ?? ''),
    bankAccountId: String(r.bank_account_id ?? ''),
    accountNumber: String(r.account_number ?? ''),
    customerName: r.account_name ?? '',
    bankName: r.bank_name || r.description || '',
    ifsc: r.ifsc_code || '',
    balance: Number(r.ledger_balance),
    disputeAmount: Number(r.dispute_amount || 0),
    isActive: r.is_active !== false,
  };
}

function mapTransaction(r) {
  return {
    id: String(r.txn_id ?? r.transaction_id ?? r.transactionId ?? r.id ?? ''),
    customerId: String(r.customer_id ?? r.customerId ?? r.account_id ?? ''),
    customerName: r.customer_name ?? r.customerName ?? '',
    accountId: String(r.account_id ?? r.accountId ?? r.account_number ?? ''),
    amount: Number(r.amount ?? 0),
    status: String(r.status ?? r.txn_status ?? '').toUpperCase(),
    reason: r.failure_reason ?? r.reason ?? r.error_message ?? r.response_message ?? '',
    time: new Date(r.created_at ?? r.timestamp ?? r.txn_date ?? r.transaction_time ?? Date.now()),
  };
}

// ---------------------------------------------------------------------------
// State (persisted so restarts don't re-send alerts)
// ---------------------------------------------------------------------------
let state = {
  seenTx: {},        // txnId -> seen timestamp
  streaks: {},       // customerId -> { count, alerted, customerName, recent[] }
  lowBalance: {},    // accountId -> { since, lastAlert, balance }
  balances: {},      // accountId -> latest snapshot of tracked accounts (for /balance)
  accounts: {},      // accountId -> every account from the APIs, incl. inactive/blocked (for admin panel)
  messages: {},      // chatId -> [{ id, at }] messages the bot can delete when clearing chats
  lastTxnCheck: null,
  lastTxnCheckBy: {}, // endpointId -> last successful txn check
  lastBalanceCheck: null,
  lastAutoClear: null,
  lastAutoClearDay: null,
  apiErrors: {},     // endpointId -> consecutive errors
};

try {
  if (fs.existsSync(cfg.stateFile)) state = { ...state, ...JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')) };
} catch (e) {
  console.error('Could not read state file, starting fresh:', e.message);
}

function saveState() {
  try {
    writeJson(cfg.stateFile, state);
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

// for frequent small changes (tracking message IDs) – coalesce writes
let saveTimer = null;
function saveStateSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveState(); }, 2000);
}

// ---------------------------------------------------------------------------
// Access lists (alert chats / allowed users) – managed from the admin panel.
// Seeded from ALERT_CHAT_IDS / ALLOWED_USER_IDS on first run; after that
// ACCESS_FILE is the source of truth.
// ---------------------------------------------------------------------------
const accessFile = dataFile('ACCESS_FILE', 'access.json');
const seedEntries = (ids) => ids.map((id) => ({ id, label: '', addedAt: Date.now() }));

let access = {
  alertChats: seedEntries(list(process.env.ALERT_CHAT_IDS)),   // [{ id, label, addedAt }]
  allowedUsers: seedEntries(list(process.env.ALLOWED_USER_IDS)),
  requests: {},                                                 // userId -> last unauthorised attempt
  blockedAccounts: [],  // [{ id, accountId, accountNumber, label, bankName, addedAt }] – no alerts, no balance check
  settings: { skipInactive: cfg.skipInactive },                 // skip accounts with is_active = false
};

let blockedKeys = new Set();

function syncAccess() {
  cfg.alertChatIds = access.alertChats.map((e) => e.id);
  cfg.allowedUserIds = access.allowedUsers.map((e) => e.id);
  cfg.skipInactive = access.settings?.skipInactive !== false;
  // an account can be blocked by its ID or its account number
  blockedKeys = new Set(access.blockedAccounts.flatMap((e) => [e.id, e.accountId, e.accountNumber]).filter(Boolean).map(String));
}

const isBlocked = (...keys) => keys.some((k) => k && blockedKeys.has(String(k)));

function saveAccess() {
  syncAccess();
  try {
    writeJson(accessFile, access);
  } catch (e) {
    console.error('Failed to save access file:', e.message);
  }
}

try {
  if (fs.existsSync(accessFile)) access = { ...access, ...JSON.parse(fs.readFileSync(accessFile, 'utf8')) };
  saveAccess();
} catch (e) {
  console.error('Could not read access file, using .env values:', e.message);
  syncAccess();
}

if (!cfg.alertChatIds.length) console.warn('⚠ No alert chats configured – send /id in your group, then add it from the admin panel');

const ID_FORMAT = {
  alertChats: /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/, // numeric chat ID or @channelusername
  allowedUsers: /^\d{1,20}$/,
};

const accessStore = {
  snapshot: () => access,

  add(listName, id, label = '') {
    if (!ID_FORMAT[listName]) throw new Error('Unknown list');
    id = String(id || '').trim();
    if (!ID_FORMAT[listName].test(id)) throw new Error(`Invalid ID "${id}"`);
    if (access[listName].some((e) => e.id === id)) throw new Error(`${id} is already in the list`);
    const entry = { id, label: String(label || '').trim().slice(0, 100), addedAt: Date.now() };
    access[listName].push(entry);
    if (listName === 'allowedUsers') delete access.requests[id];
    saveAccess();
    return entry;
  },

  remove(listName, id) {
    if (!ID_FORMAT[listName]) throw new Error('Unknown list');
    const before = access[listName].length;
    access[listName] = access[listName].filter((e) => e.id !== id);
    if (access[listName].length === before) throw new Error(`${id} not found`);
    saveAccess();
  },

  dismissRequest(userId) {
    delete access.requests[userId];
    saveAccess();
  },

  blockAccount({ id, accountId = '', accountNumber = '', label = '', bankName = '' }) {
    id = String(id || '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`Invalid account "${id}"`);
    if (isBlocked(id, accountId, accountNumber)) throw new Error(`${id} is already blocked`);
    // fill in details from the last balance check when blocking by number/ID only
    const known = Object.values(state.accounts || {}).find((a) => [a.accountId, a.accountNumber].includes(id)) || {};
    const entry = {
      id,
      accountId: String(accountId || known.accountId || ''),
      accountNumber: String(accountNumber || known.accountNumber || ''),
      label: String(label || known.customerName || '').trim().slice(0, 100),
      bankName: String(bankName || known.bankName || '').slice(0, 100),
      addedAt: Date.now(),
    };
    access.blockedAccounts.push(entry);
    saveAccess();
    // take it out of balance tracking right away (not just on the next check)
    for (const key of Object.keys(state.balances)) {
      const a = state.balances[key];
      if (isBlocked(a.accountId, a.accountNumber)) { delete state.balances[key]; delete state.lowBalance[key]; }
    }
    saveState();
    return entry;
  },

  unblockAccount(id) {
    const before = access.blockedAccounts.length;
    access.blockedAccounts = access.blockedAccounts.filter((e) => e.id !== id);
    if (access.blockedAccounts.length === before) throw new Error(`${id} not found`);
    saveAccess();
  },

  setSettings({ skipInactive }) {
    if (typeof skipInactive !== 'boolean') throw new Error('skipInactive must be true or false');
    access.settings = { ...access.settings, skipInactive };
    saveAccess();
    return access.settings;
  },

  // every account from the last balance check, flagged for the admin panel
  accounts: () => ({
    lastCheck: state.lastBalanceCheck,
    threshold: cfg.balanceThreshold,
    accounts: Object.values(state.accounts || {}).map((a) => ({
      ...a,
      blocked: isBlocked(a.accountId, a.accountNumber),
      low: a.balance < cfg.balanceThreshold,
    })),
  }),
};

// Remember who tried to use the bot without access, so the admin can approve them in one click
function recordAccessRequest(msg) {
  const u = msg.from;
  if (!u?.id) return;
  access.requests[String(u.id)] = {
    userId: String(u.id),
    name: [u.first_name, u.last_name].filter(Boolean).join(' '),
    username: u.username || '',
    chatId: String(msg.chat.id),
    chatTitle: msg.chat.title || '',
    chatType: msg.chat.type,
    text: String(msg.text || '').slice(0, 100),
    at: Date.now(),
  };
  const keys = Object.keys(access.requests).sort((a, b) => access.requests[a].at - access.requests[b].at);
  for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete access.requests[k];
  saveAccess();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lakh = (n) => (Number(n) / 100000).toFixed(2) + ' L';
const fmtTime = (d) => new Date(d).toLocaleString('en-IN', { timeZone: cfg.timezone });
const custLabel = (name, id) => (name ? `${esc(name)} (${esc(id)})` : esc(id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const acctLines = (a) =>
  `Customer: <b>${esc(a.customerName || '-')}</b>\n` +
  `Bank: ${esc(a.bankName || '-')}${a.ifsc ? ` (${esc(a.ifsc)})` : ''}\n` +
  `A/c No: <code>${esc(a.accountNumber || a.accountId)}</code>\n`;

// ---------------------------------------------------------------------------
// API endpoints (configured in the admin panel, each with its own credentials)
// ---------------------------------------------------------------------------
const endpointsOf = (type) => config.get().endpoints.filter((e) => e.type === type && e.enabled);

function apiGet(endpoint, params) {
  const headers = { 'Content-Type': 'application/json' };
  const cred = config.credentialFor(endpoint);
  if (cred?.keyHeader && cred.key) headers[cred.keyHeader] = cred.key;
  if (cred?.secretHeader && cred.secret) headers[cred.secretHeader] = cred.secret;
  return axios.get(endpoint.url, { params, headers, timeout: 20000 });
}

// ---------------------------------------------------------------------------
// Telegram bot (can be started / swapped at runtime from the admin panel)
// ---------------------------------------------------------------------------
let bot = null;
let botInfo = null;

function chunk(text, size = 4000) {
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if ((cur + line).length > size) { parts.push(cur); cur = ''; }
    cur += line + '\n';
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// Remember message IDs so chats can be cleared later (bots cannot read chat history)
function trackMessage(chatId, messageId, at = Date.now()) {
  if (!messageId) return;
  const msgs = (state.messages[String(chatId)] ||= []);
  msgs.push({ id: messageId, at });
  if (msgs.length > 5000) msgs.splice(0, msgs.length - 5000);
  saveStateSoon();
}

async function send(chatId, text) {
  if (!bot) return console.warn(`Bot not running – message to ${chatId} not sent`);
  for (const part of chunk(text)) {
    try {
      const m = await bot.sendMessage(chatId, part, { parse_mode: 'HTML', disable_web_page_preview: true });
      trackMessage(chatId, m.message_id);
    } catch (e) {
      console.error(`Send to ${chatId} failed:`, e.message);
    }
  }
}

async function notify(text) {
  console.log('[ALERT]', text.replace(/<[^>]+>/g, '').replace(/\n/g, ' | '));
  for (const id of cfg.alertChatIds) await send(id, text);
}

async function trackApiHealth(ep, ok, err) {
  const name = esc(ep.name || ep.id);
  const prev = state.apiErrors[ep.id] || 0;
  if (ok) {
    if (prev >= cfg.apiErrorThreshold) await notify(`✅ <b>${name} API is responding again</b>`);
    state.apiErrors[ep.id] = 0;
    return;
  }
  state.apiErrors[ep.id] = prev + 1;
  console.error(`${ep.name} API error (${state.apiErrors[ep.id]}):`, err?.message);
  if (state.apiErrors[ep.id] === cfg.apiErrorThreshold) {
    await notify(`🔴 <b>${name} API not responding</b>\n${cfg.apiErrorThreshold} consecutive errors.\nLast error: <code>${esc(err?.message)}</code>`);
  }
}

// ---------------------------------------------------------------------------
// Balance monitor
// ---------------------------------------------------------------------------
async function fetchAccountsFrom(ep) {
  const res = await apiGet(ep);
  return extractList(res.data).map(mapBalance)
    .filter((a) => a.accountId && Number.isFinite(a.balance))
    .map((a) => ({ ...a, source: ep.id, sourceName: ep.name }));
}

async function checkBalances() {
  const eps = endpointsOf('balance');
  if (!eps.length) return;

  const results = await Promise.all(eps.map(async (ep) => {
    try {
      const accounts = await fetchAccountsFrom(ep);
      await trackApiHealth(ep, true);
      return { ep, accounts };
    } catch (e) {
      await trackApiHealth(ep, false, e);
      return { ep, failed: true };
    }
  }));

  const failedSources = new Set(results.filter((r) => r.failed).map((r) => r.ep.id));
  if (failedSources.size === results.length) { saveState(); return; }

  const now = Date.now();
  const remindMs = cfg.balanceRemindMin * 60000;
  // keep last known data for APIs that failed this round, so their alerts don't reset
  const keepFailed = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([, a]) => failedSources.has(a.source)));
  state.accounts = keepFailed(state.accounts);
  state.balances = keepFailed(state.balances);

  const accounts = [];
  for (const r of results) {
    if (r.failed) continue;
    for (const a of r.accounts) {
      // full list (incl. inactive/blocked) for the admin panel's Accounts tab
      state.accounts[a.accountId] = { ...a, checkedAt: now };
      if ((!cfg.skipInactive || a.isActive) && !isBlocked(a.accountId, a.accountNumber)) accounts.push(a);
    }
  }

  for (const a of accounts) {
    state.balances[a.accountId] = { ...a, checkedAt: now };
    const low = state.lowBalance[a.accountId];

    if (a.balance < cfg.balanceThreshold) {
      const isNew = !low;
      if (isNew || (remindMs > 0 && now - low.lastAlert >= remindMs)) {
        await notify(
          `${isNew ? '⚠️' : '🔁'} <b>Low Balance${isNew ? '' : ' (reminder)'}</b>\n` +
          acctLines(a) +
          `Balance: <b>${inr(a.balance)}</b> (${lakh(a.balance)})\n` +
          (a.disputeAmount > 0 ? `Dispute amount: ${inr(a.disputeAmount)}\n` : '') +
          `Threshold: ${inr(cfg.balanceThreshold)} (${lakh(cfg.balanceThreshold)})` +
          (isNew ? '' : `\nLow since: ${fmtTime(low.since)}`)
        );
        state.lowBalance[a.accountId] = { since: isNew ? now : low.since, lastAlert: now, balance: a.balance };
      } else {
        low.balance = a.balance;
      }
    } else if (low) {
      await notify(
        `✅ <b>Balance Restored</b>\n` +
        acctLines(a) +
        `Balance: <b>${inr(a.balance)}</b> (${lakh(a.balance)})`
      );
      delete state.lowBalance[a.accountId];
    }
  }

  // drop low-balance entries for accounts no longer tracked (deactivated, inactive, blocked or API removed)
  for (const id of Object.keys(state.lowBalance)) if (!state.balances[id]) delete state.lowBalance[id];

  state.lastBalanceCheck = now;
  saveState();
}

// ---------------------------------------------------------------------------
// Transaction failure monitor
// ---------------------------------------------------------------------------
function failAlertText(customerId, s) {
  const rows = s.recent.map((r) =>
    `• ${fmtTime(r.time)} | A/c <code>${esc(r.accountId || '-')}</code> | ${inr(r.amount)}${r.reason ? ` | ${esc(r.reason)}` : ''}`
  ).join('\n');
  return (
    `🚨 <b>Consecutive Transaction Failures</b>\n` +
    `Customer: ${custLabel(s.customerName, customerId)}\n` +
    `Failed in a row: <b>${s.count}</b>\n\n` +
    `<b>Recent failures:</b>\n${rows}`
  );
}

function txnParams(ep, now) {
  if (!ep.sinceParam) return {};
  const base = state.lastTxnCheckBy?.[ep.id] || state.lastTxnCheck || now - cfg.txnLookbackMin * 60000;
  return { [ep.sinceParam]: new Date(base - 5 * 60000).toISOString() }; // 5 min overlap, deduped below
}

async function checkTransactions() {
  const eps = endpointsOf('transactions');
  if (!eps.length) return;

  const startedAt = Date.now();
  state.lastTxnCheckBy ||= {};
  const txns = [];
  for (const ep of eps) {
    try {
      const res = await apiGet(ep, txnParams(ep, startedAt));
      txns.push(...extractList(res.data).map(mapTransaction).filter((t) => t.id && t.customerId));
      state.lastTxnCheckBy[ep.id] = startedAt;
      await trackApiHealth(ep, true);
    } catch (e) {
      await trackApiHealth(ep, false, e);
    }
  }
  txns.sort((a, b) => a.time - b.time);

  for (const t of txns) {
    if (state.seenTx[t.id]) continue;
    const isFail = cfg.failedStatuses.has(t.status);
    const isOk = cfg.successStatuses.has(t.status);
    if (!isFail && !isOk) continue; // pending/processing: check again next cycle

    state.seenTx[t.id] = Date.now();
    if (isBlocked(t.accountId, t.customerId)) {
      delete state.streaks[t.customerId];
      continue; // blocked account: no failure alerts
    }
    const s = (state.streaks[t.customerId] ||= { count: 0, alerted: false, customerName: '', recent: [] });
    if (t.customerName) s.customerName = t.customerName;

    if (isFail) {
      s.count += 1;
      s.recent.push({ id: t.id, accountId: t.accountId, amount: t.amount, reason: t.reason, time: t.time.toISOString() });
      s.recent = s.recent.slice(-5);

      const over = s.count - cfg.failThreshold;
      const shouldAlert = s.count >= cfg.failThreshold &&
        (!s.alerted || (cfg.failRepeatEvery > 0 && over % cfg.failRepeatEvery === 0));
      if (shouldAlert) {
        await notify(failAlertText(t.customerId, s));
        s.alerted = true;
      }
    } else {
      if (s.alerted) {
        await notify(
          `✅ <b>Transactions Recovered</b>\n` +
          `Customer: ${custLabel(s.customerName, t.customerId)}\n` +
          `Successful txn after <b>${s.count}</b> failures.\n` +
          `Txn: <code>${esc(t.id)}</code> | ${inr(t.amount)} | ${fmtTime(t.time)}`
        );
      }
      delete state.streaks[t.customerId];
    }
  }

  // forget processed txn IDs older than 2 days
  const cutoff = Date.now() - 2 * 24 * 3600 * 1000;
  for (const [id, ts] of Object.entries(state.seenTx)) if (ts < cutoff) delete state.seenTx[id];

  if (Object.values(state.lastTxnCheckBy).includes(startedAt)) state.lastTxnCheck = startedAt;
  saveState();
}

// ---------------------------------------------------------------------------
// Chat clearing – deletes messages the bot sent and the commands it handled.
// Telegram only allows bots to delete messages younger than 48 hours.
// ---------------------------------------------------------------------------
const DELETE_WINDOW_MS = 48 * 3600 * 1000;
let clearing = false;

async function deleteMessage(chatId, messageId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await bot.deleteMessage(chatId, messageId);
      return true;
    } catch (e) {
      const retryAfter = e.response?.body?.parameters?.retry_after;
      if (!retryAfter) return false; // already deleted, too old, or no permission
      await sleep(retryAfter * 1000);
    }
  }
  return false;
}

async function clearChatNow(chatId, olderThanMs) {
  const now = Date.now();
  const msgs = state.messages[chatId] || [];
  delete state.messages[chatId]; // new messages arriving meanwhile start a fresh list
  const keep = [];
  let deleted = 0;
  let failed = 0;
  for (const m of msgs) {
    if (now - m.at < olderThanMs) { keep.push(m); continue; }
    if (now - m.at >= DELETE_WINDOW_MS) { failed++; continue; } // Telegram won't delete it any more
    if (await deleteMessage(chatId, m.id)) deleted++; else failed++;
    await sleep(40); // stay well under Telegram rate limits
  }
  const all = [...keep, ...(state.messages[chatId] || [])];
  if (all.length) state.messages[chatId] = all; else delete state.messages[chatId];
  return { deleted, failed };
}

// chatId omitted = all chats
async function clearChats({ chatId, olderThanMs = 0, reason = 'manual' } = {}) {
  if (!bot) throw new Error('Bot is not running – set the bot token first');
  if (clearing) throw new Error('A chat clear is already running');
  clearing = true;
  try {
    const ids = chatId ? [String(chatId)] : Object.keys(state.messages);
    const total = { chats: ids.length, deleted: 0, failed: 0 };
    for (const id of ids) {
      const r = await clearChatNow(id, olderThanMs);
      total.deleted += r.deleted;
      total.failed += r.failed;
    }
    saveState();
    if (total.deleted || total.failed || reason === 'manual') {
      console.log(`[CLEAR] ${reason}: deleted ${total.deleted} message(s) in ${total.chats} chat(s)` +
        (total.failed ? `, ${total.failed} could not be deleted` : ''));
    }
    return total;
  } finally {
    clearing = false;
  }
}

async function autoClearTick() {
  const ac = config.get().autoClear;
  if (!ac?.enabled || !bot || clearing) return;
  const now = new Date();
  if (ac.mode === 'daily') {
    const hm = now.toLocaleTimeString('en-GB', { timeZone: cfg.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const today = now.toLocaleDateString('en-CA', { timeZone: cfg.timezone });
    if (hm !== ac.time || state.lastAutoClearDay === today) return;
    state.lastAutoClearDay = today;
  } else if (Date.now() - (state.lastAutoClear || 0) < 10 * 60000) {
    return; // rolling mode: every 10 minutes
  }
  state.lastAutoClear = Date.now();
  await clearChats({ olderThanMs: ac.olderThanHours * 3600 * 1000, reason: `auto-clear (older than ${ac.olderThanHours}h)` });
}

function chatsView() {
  const now = Date.now();
  const labels = new Map([...access.alertChats, ...access.allowedUsers].map((e) => [e.id, e.label]));
  const ids = new Set([...Object.keys(state.messages), ...cfg.alertChatIds]);
  return {
    autoClear: config.get().autoClear,
    lastAutoClear: state.lastAutoClear,
    timezone: cfg.timezone,
    chats: [...ids].map((id) => {
      const msgs = state.messages[id] || [];
      return {
        chatId: id,
        label: labels.get(id) || '',
        isAlertChat: cfg.alertChatIds.includes(id),
        messages: msgs.length,
        deletable: msgs.filter((m) => now - m.at < DELETE_WINDOW_MS).length,
        oldest: msgs[0]?.at || null,
        newest: msgs.at(-1)?.at || null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Scheduler (no overlapping runs)
// ---------------------------------------------------------------------------
function schedule(name, fn, seconds) {
  let running = false;
  const tick = async () => {
    if (!running) {
      running = true;
      try { await fn(); } catch (e) { console.error(`${name} crashed:`, e); }
      running = false;
    }
    setTimeout(tick, seconds * 1000);
  };
  tick();
}

// ---------------------------------------------------------------------------
// Bot commands (restricted to internal chats/users)
// ---------------------------------------------------------------------------
const isAllowed = (msg) =>
  cfg.alertChatIds.includes(String(msg.chat.id)) || cfg.allowedUserIds.includes(String(msg.from?.id));

const who = (msg) => {
  const u = msg.from || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? '@' + u.username : '');
  return `${name ? name + ' ' : ''}(${u.id}) in chat ${msg.chat.id}`;
};

const HELP =
  `<b>Internal Monitoring Bot</b>\n\n` +
  `/status – bot health & thresholds\n` +
  `/balance – all account balances\n` +
  `/balance &lt;search&gt; or /bal &lt;search&gt; – live balance of a specific account\n` +
  `   e.g. /bal 7854  ·  /bal Deepak  ·  /bal 786543214567854\n` +
  `/low – accounts below threshold\n` +
  `/failures – customers with active failure streaks\n` +
  `/check – run both checks now\n` +
  `/clear – delete the bot's messages in this chat\n` +
  `/id – show chat/user ID`;

// /bal <account no | last digits | name | bank | id>  -> live lookup from all balance APIs
async function balanceLookup(msg, q) {
  const eps = endpointsOf('balance');
  if (!eps.length) return send(msg.chat.id, '❌ No balance API configured.');

  const results = await Promise.allSettled(eps.map(fetchAccountsFrom));
  const accounts = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
  if (results.every((r) => r.status === 'rejected')) {
    return send(msg.chat.id, `❌ Could not reach balance API: <code>${esc(results[0].reason?.message)}</code>`);
  }

  const exact = accounts.filter((a) => a.accountNumber === q || a.accountId === q);
  const found = exact.length ? exact : accounts.filter((a) =>
    a.accountNumber.endsWith(q) ||
    a.customerName.toLowerCase().includes(q) ||
    a.bankName.toLowerCase().includes(q));

  if (!found.length) return send(msg.chat.id, `No account found for "<b>${esc(q)}</b>".`);
  if (found.length > 15) return send(msg.chat.id, `${found.length} accounts match "<b>${esc(q)}</b>" – please be more specific.`);

  const text = found.map((a) =>
    `${a.balance < cfg.balanceThreshold ? '🔴' : '🟢'} <b>${esc(a.customerName || '-')}</b>${a.isActive ? '' : ' <i>(inactive)</i>'}${isBlocked(a.accountId, a.accountNumber) ? ' <i>(blocked – no alerts)</i>' : ''}\n` +
    `Bank: ${esc(a.bankName || '-')}${a.ifsc ? ` (${esc(a.ifsc)})` : ''}\n` +
    `A/c No: <code>${esc(a.accountNumber)}</code>\n` +
    `Balance: <b>${inr(a.balance)}</b> (${lakh(a.balance)})` +
    (a.disputeAmount > 0 ? `\nDispute amount: ${inr(a.disputeAmount)}` : '')
  ).join('\n\n');
  return send(msg.chat.id, `${text}\n\n<i>Live as of ${fmtTime(Date.now())}</i>`);
}

function registerHandlers(b) {
  function command(regex, handler) {
    b.onText(regex, async (msg, match) => {
      trackMessage(msg.chat.id, msg.message_id, msg.date * 1000);
      if (!isAllowed(msg)) {
        console.warn(`[DENIED] ${who(msg)}: ${msg.text}`);
        recordAccessRequest(msg);
        return send(msg.chat.id, '⛔ Not authorised. Send /id and ask admin to whitelist you.');
      }
      console.log(`[CMD] ${who(msg)}: ${msg.text}`);
      try {
        await handler(msg, match);
      } catch (e) {
        console.error(`[CMD] ${msg.text} failed:`, e.message);
        await send(msg.chat.id, `Error: ${esc(e.message)}`);
      }
    });
  }

  // /id works for everyone so you can find chat IDs during setup
  b.onText(/^\/id/, (msg) => {
    trackMessage(msg.chat.id, msg.message_id, msg.date * 1000);
    if (!isAllowed(msg)) recordAccessRequest(msg);
    return send(msg.chat.id, `Chat ID: <code>${msg.chat.id}</code>\nYour user ID: <code>${msg.from?.id}</code>`);
  });

  command(/^\/(start|help)/, (msg) => send(msg.chat.id, HELP));

  command(/^\/status/, (msg) => {
    const apis = config.get().endpoints.map((e) =>
      `• ${esc(e.name)} (${e.type})${e.enabled ? '' : ' – disabled'}${state.apiErrors[e.id] ? ` – ${state.apiErrors[e.id]} error(s)` : ''}`
    ).join('\n') || '• none configured';
    const ac = config.get().autoClear;
    return send(msg.chat.id,
      `<b>Status</b>\n` +
      `Last balance check: ${state.lastBalanceCheck ? fmtTime(state.lastBalanceCheck) : 'never'}\n` +
      `Last txn check: ${state.lastTxnCheck ? fmtTime(state.lastTxnCheck) : 'never'}\n\n` +
      `<b>APIs</b>\n${apis}\n\n` +
      `Balance threshold: ${inr(cfg.balanceThreshold)} (${lakh(cfg.balanceThreshold)})\n` +
      `Failure alert after: ${cfg.failThreshold} consecutive fails\n` +
      `Accounts tracked: ${Object.keys(state.balances).length}\n` +
      `Blocked accounts: ${access.blockedAccounts.length} · Inactive accounts: ${cfg.skipInactive ? 'skipped' : 'checked'}\n` +
      `Low balance now: ${Object.keys(state.lowBalance).length}\n` +
      `Active failure streaks: ${Object.values(state.streaks).filter((s) => s.count > 0).length}\n` +
      `Chat auto-clear: ${ac.enabled ? (ac.mode === 'daily' ? `daily at ${ac.time}` : 'continuous') + `, older than ${ac.olderThanHours}h` : 'off'}`
    );
  });

  command(/^\/bal(?:@\w+)?(?:\s+(.+))?$/, (msg, match) => {
    const q = (match[1] || '').trim().toLowerCase();
    if (!q) return send(msg.chat.id, 'Usage: <code>/bal &lt;account number / last 4 digits / name&gt;</code>\nExample: <code>/bal 7854</code>');
    return balanceLookup(msg, q);
  });

  // /balance            -> all accounts
  // /balance <search>   -> specific account (live)
  command(/^\/balance(?:@\w+)?(?:\s+(.+))?$/, (msg, match) => {
    const q = (match[1] || '').trim().toLowerCase();
    if (q) return balanceLookup(msg, q);
    const rows = Object.values(state.balances).sort((a, b) => a.balance - b.balance);
    if (!rows.length) return send(msg.chat.id, 'No balance data yet.');
    const text = rows.map((a) =>
      `${a.balance < cfg.balanceThreshold ? '🔴' : '🟢'} <b>${esc(a.customerName || '-')}</b> | ${esc(a.bankName || '-')} | <code>${esc(a.accountNumber)}</code> | ${inr(a.balance)}`
    ).join('\n');
    return send(msg.chat.id, `<b>Balances</b> (lowest first)\n\n${text}`);
  });

  command(/^\/low/, (msg) => {
    const rows = Object.entries(state.lowBalance);
    if (!rows.length) return send(msg.chat.id, '✅ All accounts above threshold.');
    const text = rows.map(([id, l]) => {
      const a = state.balances[id] || {};
      return `🔴 <b>${esc(a.customerName || '-')}</b> | ${esc(a.bankName || '-')} | <code>${esc(a.accountNumber || id)}</code> | ${inr(l.balance)} | since ${fmtTime(l.since)}`;
    }).join('\n');
    return send(msg.chat.id, `<b>Low Balance Accounts</b>\n\n${text}`);
  });

  command(/^\/failures/, (msg) => {
    const rows = Object.entries(state.streaks).filter(([, s]) => s.count > 0).sort((a, b) => b[1].count - a[1].count);
    if (!rows.length) return send(msg.chat.id, '✅ No active failure streaks.');
    const text = rows.map(([id, s]) =>
      `${s.count >= cfg.failThreshold ? '🚨' : '⚠️'} ${custLabel(s.customerName, id)} – ${s.count} in a row` +
      (s.recent.at(-1)?.reason ? ` (last: ${esc(s.recent.at(-1).reason)})` : '')
    ).join('\n');
    return send(msg.chat.id, `<b>Failure Streaks</b>\n\n${text}`);
  });

  command(/^\/check/, async (msg) => {
    await send(msg.chat.id, '⏳ Running checks...');
    await Promise.all([checkBalances(), checkTransactions()]);
    await send(msg.chat.id, '✅ Checks complete. Use /status for details.');
  });

  command(/^\/clear/, async (msg) => {
    const r = await clearChats({ chatId: msg.chat.id, reason: `/clear by ${who(msg)}` });
    if (r.failed) await send(msg.chat.id, `🧹 Cleared ${r.deleted} message(s). ${r.failed} could not be deleted (older than 48h, or the bot is not a group admin).`);
  });

  b.on('polling_error', (e) => console.error('Telegram polling error:', e.message));
}

async function startBot(token) {
  if (bot) {
    const old = bot;
    bot = null;
    botInfo = null;
    try { await old.stopPolling({ cancel: true }); } catch { /* ignore */ }
  }
  if (!token) {
    console.warn('⚠ Telegram bot token not set – add it in the admin panel (Settings tab)');
    return null;
  }
  const b = new TelegramBot(token, { polling: { autoStart: false } });
  const me = await b.getMe(); // validates the token
  registerHandlers(b);
  bot = b;
  botInfo = { id: me.id, username: me.username, name: me.first_name };
  await b.startPolling();
  console.log(`🤖 Telegram bot @${me.username} connected`);
  return botInfo;
}

async function changeBotToken(token) {
  token = String(token || '').trim();
  try {
    await new TelegramBot(token, { polling: false }).getMe(); // check before replacing the working token
  } catch (e) {
    throw new Error('Telegram rejected this token: ' + (e.response?.body?.description || e.message));
  }
  config.setBotToken(token);
  refreshSecrets();
  return startBot(token);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
startBot(config.get().telegram.botToken).catch((e) =>
  console.error('Could not start Telegram bot:', e.response?.body?.description || e.message, '– check the token in the admin panel'));

if (!endpointsOf('balance').length) console.warn('⚠ No balance API configured – add one in the admin panel (Settings tab)');
if (!endpointsOf('transactions').length) console.warn('⚠ No transactions API configured – add one in the admin panel (Settings tab)');

schedule('balance', checkBalances, cfg.balancePollSec);
schedule('transactions', checkTransactions, cfg.txnPollSec);
setInterval(() => autoClearTick().catch((e) => console.error('Auto-clear failed:', e.message)), 30 * 1000);

require('./admin').startAdmin({
  port: Number(process.env.ADMIN_PORT || process.env.PORT || 3000), // Railway/Render inject PORT
  host: process.env.ADMIN_HOST || '127.0.0.1',
  user: process.env.ADMIN_USER || 'admin',
  password: process.env.ADMIN_PASSWORD,
  trustProxy: process.env.ADMIN_TRUST_PROXY === 'true',
  getBot: () => bot,
  access: accessStore,

  runBalanceCheck: () => {
    if (!endpointsOf('balance').length) throw new Error('No enabled balance API – add one in Settings');
    return checkBalances();
  },

  async sendTest(chatId) {
    if (!bot) throw new Error('Bot is not running – set the bot token first');
    const m = await bot.sendMessage(chatId, '✅ Test message from the monitoring bot admin panel.');
    trackMessage(chatId, m.message_id);
  },

  chats: {
    view: chatsView,
    clear: (chatId) => clearChats({ chatId, reason: chatId ? `admin cleared chat ${chatId}` : 'admin cleared all chats' }),
    setAutoClear: (data) => config.setAutoClear(data),
  },

  settings: {
    view: () => ({ ...config.publicView(), bot: botInfo, timezone: cfg.timezone }),
    setBotToken: changeBotToken,
    upsertCredential: (data) => { const id = config.upsertCredential(data); refreshSecrets(); return id; },
    deleteCredential: (id) => { config.deleteCredential(id); refreshSecrets(); },
    upsertEndpoint: (data) => config.upsertEndpoint(data),
    deleteEndpoint: (id) => config.deleteEndpoint(id),
    // call an API once and report what came back
    async testEndpoint(id) {
      const ep = config.get().endpoints.find((e) => e.id === id);
      if (!ep) throw new Error('API not found');
      const started = Date.now();
      const res = await apiGet(ep, ep.type === 'transactions' ? txnParams(ep, started) : undefined);
      const items = extractList(res.data);
      return { status: res.status, ms: Date.now() - started, items: items.length, fields: Object.keys(items[0] || {}).slice(0, 25) };
    },
  },
});

const shutdown = () => { saveState(); console.log('State saved. Bye.'); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('🟢 Monitoring service started');
