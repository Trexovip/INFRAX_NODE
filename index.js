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
const crypto = require('crypto');
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

// Bot token, functions (APIs + keys), auto-clear – editable in the admin panel
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

// a field that may be a plain value or an object like { name: "…" }
const nameOf = (v) => String((v && typeof v === 'object' ? v.name ?? v.title ?? '' : v) ?? '');

function mapTransaction(r) {
  return {
    id: String(r.txn_id ?? r.transaction_id ?? r.transactionId ?? r.id ?? ''),
    customerId: String(r.customer_id ?? r.customerId ?? r.customer?.id ?? r.account_id ?? ''),
    customerName: nameOf(r.customer_name ?? r.customerName ?? r.customer),
    accountId: String(r.account_id ?? r.accountId ?? r.account_number ?? ''),
    amount: Number(r.amount ?? 0),
    status: String(r.status ?? r.txn_status ?? '').toUpperCase(),
    reason: r.failure_reason ?? r.pending_reason ?? r.reason ?? r.status_reason ?? r.error_message ?? r.response_message ?? r.status_message ?? r.remarks ?? r.message ?? '',
    orgName: nameOf(r.organisation_name ?? r.organization_name ?? r.org_name ?? r.organisation ?? r.organization ?? r.merchant_name ?? r.business_name ?? r.company_name ?? r.merchant),
    utr: String(r.utr ?? r.rrn ?? r.bank_reference ?? r.bank_ref_no ?? ''),
    mode: String(r.payment_mode ?? r.mode ?? r.payment_method ?? r.method ?? ''),
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
  webhookSeen: {},   // webhookId:txnId:status -> time (dedupes webhook retries)
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
// API calls. Every API belongs to a function (admin panel → Functions) and uses
// that function's master key, its own key, or no key.
// ---------------------------------------------------------------------------
function apiRequest(fn, api, params = {}) {
  const headers = { 'Content-Type': 'application/json', ...config.authHeaders(fn, api) };
  return api.method === 'POST'
    ? axios.post(api.url, params, { headers, timeout: 20000 })
    : axios.get(api.url, { params, headers, timeout: 20000 });
}

// enabled APIs of a built-in function ('balance' | 'transactions'), each tagged with its function
function endpointsOf(builtinId) {
  const fn = config.fn(builtinId);
  if (!fn?.enabled) return [];
  return fn.apis.filter((a) => a.enabled).map((a) => ({ ...a, fn }));
}

const apiGet = (ep, params) => apiRequest(ep.fn, ep, params);

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

// one finished (failed / successful) transaction → update the customer's failure streak.
// Used by both the transactions API poller and transaction webhooks; seenTx dedupes between them.
async function processTransaction(t, isFail) {
  state.seenTx[t.id] = Date.now();
  if (isBlocked(t.accountId, t.customerId)) {
    delete state.streaks[t.customerId];
    return; // blocked account: no failure alerts
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

// forget processed txn IDs (and webhook dedupe keys) older than 2 days
function forgetOldTransactions() {
  const cutoff = Date.now() - 2 * 24 * 3600 * 1000;
  for (const [id, ts] of Object.entries(state.seenTx)) if (ts < cutoff) delete state.seenTx[id];
  for (const [k, ts] of Object.entries(state.webhookSeen || {})) if (ts < cutoff) delete state.webhookSeen[k];
  // webhook streaks: forget customers with no activity for 7 days
  const idle = Date.now() - 7 * 24 * 3600 * 1000;
  for (const customers of Object.values(state.whStreaks || {})) {
    for (const [k, c] of Object.entries(customers)) if ((c.updatedAt || 0) < idle) delete customers[k];
  }
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
    await processTransaction(t, isFail);
  }

  forgetOldTransactions();

  if (Object.values(state.lastTxnCheckBy).includes(startedAt)) state.lastTxnCheck = startedAt;
  saveState();
}

// ---------------------------------------------------------------------------
// Transaction webhooks – your payment API POSTs transaction updates to
// /webhook/<id> and the bot notifies failed / pending / successful transactions.
// ---------------------------------------------------------------------------
const WEBHOOK_KINDS = {
  failed: { icon: '❌', title: 'Transaction Failed' },
  pending: { icon: '⏳', title: 'Transaction Pending' },
  success: { icon: '✅', title: 'Transaction Successful' },
};
const deliveries = new Map(); // webhookId -> recent deliveries (memory only – they contain customer data)

function logDelivery(whId, entry) {
  const list = deliveries.get(whId) || [];
  list.unshift({ at: Date.now(), txns: [], ...entry });
  deliveries.set(whId, list.slice(0, 25));
  return list[0];
}

function statusKind(wh, status) {
  const has = (k) => list(wh.statuses?.[k]).includes(status);
  return has('failed') ? 'failed' : has('success') ? 'success' : has('pending') ? 'pending' : null;
}

const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function verifyWebhook(wh, pathSecret, headers, rawBody) {
  if (wh.auth === 'none') return true; // no secret – anyone with the URL can post
  const secret = config.webhookSecret(wh); // own secret, or the function's master key/secret
  if (!secret) return false;
  if (wh.auth === 'url') return safeEq(pathSecret || '', secret);
  const value = String(headers[wh.headerName.toLowerCase()] || '').trim();
  if (wh.auth === 'header') return safeEq(value.replace(/^Bearer\s+/i, ''), secret);
  if (wh.auth === 'hmac') {
    // HMAC-SHA256 of the raw body, hex or base64, optionally prefixed "sha256="
    const sig = value.replace(/^sha256=/i, '');
    const mac = (enc) => crypto.createHmac('sha256', secret).update(rawBody).digest(enc);
    return safeEq(sig.toLowerCase(), mac('hex')) || safeEq(sig, mac('base64'));
  }
  return false;
}

function parseWebhookBody(raw, contentType) {
  const body = raw.toString('utf8');
  if (/x-www-form-urlencoded/i.test(contentType || '')) {
    const obj = Object.fromEntries(new URLSearchParams(body));
    for (const k of ['payload', 'data', 'body']) {
      if (typeof obj[k] === 'string') { try { return JSON.parse(obj[k]); } catch { /* not JSON */ } }
    }
    return obj;
  }
  return JSON.parse(body);
}

// the transaction record(s) inside a delivery: {…}, [{…}], {data:{…}}, {data:[…]}, {event, transaction:{…}} …
function webhookRecords(p, depth = 0) {
  if (Array.isArray(p)) return p.filter((r) => r && typeof r === 'object');
  if (!p || typeof p !== 'object') return [];
  if (depth < 3) {
    for (const k of ['data', 'transaction', 'txn', 'payload', 'object', 'payment']) {
      const v = p[k];
      if (Array.isArray(v) || (v && typeof v === 'object')) return webhookRecords(v, depth + 1);
    }
  }
  return [p];
}

// status from the event name when the record has none, e.g. "payment.failed" → FAILED
const eventStatus = (payload) =>
  String(payload?.status ?? payload?.event ?? payload?.type ?? '').split(/[._:\s]/).pop().toUpperCase();

function webhookText(wh, t, kind, test) {
  const k = WEBHOOK_KINDS[kind];
  return `${k.icon} <b>${k.title}</b>${test ? ' (test)' : ''}\n` +
    `Customer: ${custLabel(t.customerName, t.customerId) || '-'}\n` +
    (t.orgName ? `Organisation: ${esc(t.orgName)}\n` : '') +
    (t.accountId ? `A/c: <code>${esc(t.accountId)}</code>\n` : '') +
    `Amount: <b>${inr(t.amount)}</b>\n` +
    `Txn: <code>${esc(t.id)}</code>\n` +
    (t.utr ? `UTR: <code>${esc(t.utr)}</code>\n` : '') +
    (t.mode ? `Mode: ${esc(t.mode)}\n` : '') +
    `Status: ${esc(t.status)}\n` +
    (kind !== 'success' && t.reason ? `Reason: ${esc(t.reason)}\n` : '') +
    `Time: ${fmtTime(t.time)}\n` +
    `<i>via ${esc(wh.name)}</i>`;
}

async function notifyTo(chatIds, text) {
  const ids = list(chatIds);
  if (!ids.length) return notify(text);
  console.log('[ALERT]', text.replace(/<[^>]+>/g, '').replace(/\n/g, ' | '));
  for (const id of ids) await send(id, text);
}

// ---- "N in a row" alerts per customer (failed / pending) ----
const STREAK_TITLES = { failed: ['🚨', 'failed'], pending: ['⏳', 'pending'] };
const streakCustomerKey = (t) => t.customerId || t.customerName || t.orgName || t.accountId || 'unknown';

function streakHeader(c) {
  return `Customer: <b>${esc(c.name || '-')}</b>${c.customerId ? ` (<code>${esc(c.customerId)}</code>)` : ''}\n` +
    `Organisation: <b>${esc(c.org || '-')}</b>\n` +
    (c.accountId ? `A/c: <code>${esc(c.accountId)}</code>\n` : '');
}

function streakText(wh, c, kind, count, limit, test) {
  const [icon, word] = STREAK_TITLES[kind];
  const rows = c.txns.slice(-limit).map((x, i) =>
    `${i + 1}. <code>${esc(x.id)}</code> · ${inr(x.amount)} · ${fmtTime(x.time)}` +
    (kind === 'pending' ? ` · ${esc(x.status)}` : '') +
    (x.org && x.org !== c.org ? ` · ${esc(x.org)}` : '') +
    `\n    Reason: ${esc(x.reason || 'not given')}`
  ).join('\n');
  return `${icon} <b>${count} ${word} transactions in a row</b>${test ? ' (test)' : ''}\n` +
    streakHeader(c) +
    `\n<b>${count > limit ? `Last ${limit}` : `All ${limit}`} ${word} transactions:</b>\n${rows}\n\n<i>via ${esc(wh.name)}</i>`;
}

function streakEndedText(wh, c, kind, latest) {
  const what = kind === 'failed' ? 'Failures stopped' : 'Pending cleared';
  return `✅ <b>${what}</b>\n` + streakHeader(c) +
    `Latest txn <code>${esc(latest.id)}</code> is ${esc(latest.status)} · ${inr(latest.amount)} · ${fmtTime(latest.time)}\n<i>via ${esc(wh.name)}</i>`;
}

async function updateWebhookStreaks(wh, t, kind, summary) {
  const limits = { failed: Number(wh.streak?.failed ?? 5), pending: Number(wh.streak?.pending ?? 5) };
  if (!limits.failed && !limits.pending) return;

  state.whStreaks ||= {};
  const customers = (state.whStreaks[wh.id] ||= {});
  const c = (customers[streakCustomerKey(t)] ||= { txns: [], alerted: {} });
  if (t.customerName) c.name = t.customerName;
  if (t.orgName) c.org = t.orgName;
  if (t.customerId) c.customerId = t.customerId;
  if (t.accountId) c.accountId = t.accountId;
  c.updatedAt = Date.now();

  // one entry per transaction, in arrival order; a later update (pending → failed) changes it in place
  const rec = { id: t.id, kind, status: t.status, amount: t.amount, reason: t.reason, time: t.time.toISOString(), org: t.orgName };
  const i = c.txns.findIndex((x) => x.id === t.id);
  if (i >= 0) c.txns[i] = { ...c.txns[i], ...rec, reason: t.reason || c.txns[i].reason };
  else c.txns.push(rec);
  c.txns = c.txns.slice(-50);

  const trailing = (k) => {
    let n = 0;
    for (let j = c.txns.length - 1; j >= 0 && c.txns[j].kind === k; j--) n++;
    return n;
  };

  const parts = [];
  for (const k of ['failed', 'pending']) {
    const limit = limits[k];
    if (!limit) continue;
    const n = trailing(k);
    if (n) parts.push(`${k} ${n}/${limit}`);
    if (n >= limit) {
      // alert at N in a row, then again at 2N, 3N …
      if (!c.alerted[k] || (n !== c.alerted[k] && (n - limit) % limit === 0)) {
        await notifyTo(wh.chatIds, streakText(wh, c, k, n, limit));
        c.alerted[k] = n;
        summary.notified = true;
        parts.push(`${k} streak alert sent`);
      }
    } else if (c.alerted[k]) {
      await notifyTo(wh.chatIds, streakEndedText(wh, c, k, c.txns.at(-1)));
      c.alerted[k] = 0;
      parts.push(`${k} streak ended`);
    }
  }
  if (parts.length) summary.streak = parts.join(' · ');

  // keep the 2000 most recently active customers per webhook
  const keys = Object.keys(customers);
  if (keys.length > 2000) {
    keys.sort((a, b) => customers[a].updatedAt - customers[b].updatedAt);
    for (const k of keys.slice(0, keys.length - 2000)) delete customers[k];
  }
}

// deliveries are handled one at a time, in arrival order, so streaks count correctly
let webhookQueue = Promise.resolve();

async function handleWebhookRecords(wh, payload, records, entry) {
  for (const r of records) {
    const t = mapTransaction(r);
    if (!t.status) t.status = eventStatus(payload);
    const kind = statusKind(wh, t.status);
    const summary = { id: t.id, status: t.status, kind: kind || 'ignored' };
    entry.txns.push(summary);

    if (!t.id) { summary.note = 'no transaction ID found'; continue; }
    if (!kind) { summary.note = 'status not in any list'; continue; }
    if (isBlocked(t.accountId, t.customerId)) { summary.note = 'blocked account'; continue; }

    // providers retry deliveries – notify once per transaction + status
    state.webhookSeen ||= {};
    const key = `${wh.id}:${t.id}:${t.status}`;
    if (state.webhookSeen[key]) { summary.note = 'duplicate'; continue; }
    state.webhookSeen[key] = Date.now();

    if (wh.notify?.[kind]) {
      await notifyTo(wh.chatIds, webhookText(wh, t, kind));
      summary.notified = true;
    }
    await updateWebhookStreaks(wh, t, kind, summary);
    if (wh.feedStreaks && kind !== 'pending' && t.customerId && !state.seenTx[t.id]) {
      await processTransaction(t, kind === 'failed');
    }
  }
  forgetOldTransactions();
  saveState();
  console.log(`[WEBHOOK] ${wh.name}: ` + (entry.txns.map((s) =>
    `${s.id || '?'} ${s.status || '?'}${s.streak ? ` [${s.streak}]` : ''}${s.notified ? ' → notified' : s.note ? ` (${s.note})` : ''}`).join(', ') || 'no transactions'));
}

// called by the admin server for POST /webhook/:id[/:secret]
function receiveWebhook({ id, pathSecret, headers, rawBody, contentType }) {
  const wh = config.webhook(id);
  if (!wh || !wh.enabled) return { status: 404, body: { error: 'Unknown webhook' } };

  const preview = rawBody.toString('utf8').slice(0, 4000);
  if (!verifyWebhook(wh, pathSecret, headers, rawBody)) {
    logDelivery(wh.id, { httpStatus: 401, note: 'Rejected – secret/signature did not match', body: preview });
    console.warn(`[WEBHOOK] ${wh.name}: rejected a delivery (secret/signature did not match)`);
    return { status: 401, body: { error: 'Unauthorized' } };
  }

  // function switched off → accept (so the provider doesn't keep retrying) but do nothing
  const fn = config.fn(wh.fnId);
  if (!fn?.enabled) {
    logDelivery(wh.id, { httpStatus: 200, note: `Ignored – function “${fn?.name || wh.fnId}” is switched off`, body: preview });
    return { status: 200, body: { ok: true, ignored: 'function disabled' } };
  }

  let payload;
  try {
    payload = parseWebhookBody(rawBody, contentType);
  } catch {
    logDelivery(wh.id, { httpStatus: 400, note: 'Body is not valid JSON', body: preview });
    return { status: 400, body: { error: 'Invalid JSON' } };
  }

  const records = webhookRecords(payload);
  const entry = logDelivery(wh.id, { httpStatus: 200, note: records.length ? '' : 'No transaction in payload', body: preview });
  // answer the provider right away; notifications are sent in the background
  webhookQueue = webhookQueue
    .then(() => handleWebhookRecords(wh, payload, records, entry))
    .catch((e) => console.error(`[WEBHOOK] ${wh.name} failed:`, e.message));
  return { status: 200, body: { ok: true, received: records.length } };
}

async function sendWebhookTest(id, kind) {
  const wh = config.webhook(id);
  if (!wh) throw new Error('Webhook not found');
  // sample "5 in a row" alert
  if (kind === 'failed_streak' || kind === 'pending_streak') {
    const k = kind.split('_')[0];
    const limit = Number(wh.streak?.[k]) || 5;
    const reasons = k === 'failed'
      ? ['Insufficient funds', 'Bank server down', 'Invalid account number', 'Limit exceeded', 'Timeout from bank']
      : ['Awaiting bank confirmation', 'In bank queue', 'Beneficiary bank slow', 'Processing', 'Awaiting UTR'];
    const c = {
      name: 'Test Customer', customerId: 'CUST-TEST', org: 'Test Organisation Pvt Ltd', accountId: 'XXXX1234',
      txns: Array.from({ length: limit }, (_, i) => ({
        id: `TEST-${Date.now()}-${i + 1}`, kind: k, status: list(wh.statuses?.[k])[0] || k.toUpperCase(),
        amount: 1000 * (i + 1), reason: reasons[i % reasons.length], time: new Date(Date.now() - (limit - i) * 60000).toISOString(),
      })),
    };
    await notifyTo(wh.chatIds, streakText(wh, c, k, limit, limit, true));
    logDelivery(wh.id, { httpStatus: 200, note: `Test “${limit} ${k} in a row” alert sent from the admin panel` });
    return;
  }
  if (!WEBHOOK_KINDS[kind]) throw new Error('Unknown type');
  const t = {
    id: `TEST-${Date.now()}`, customerId: 'CUST-TEST', customerName: 'Test Customer', accountId: 'XXXX1234',
    amount: 1234.5, status: list(wh.statuses?.[kind])[0] || kind.toUpperCase(),
    reason: kind === 'failed' ? 'Test failure reason' : kind === 'pending' ? 'Awaiting bank confirmation' : '',
    orgName: 'Test Organisation Pvt Ltd', utr: '123456789012', mode: 'IMPS', time: new Date(),
  };
  await notifyTo(wh.chatIds, webhookText(wh, t, kind, true));
  logDelivery(wh.id, { httpStatus: 200, note: `Test ${kind} notification sent from the admin panel`, txns: [{ id: t.id, status: t.status, kind, notified: true }] });
}

// ---------------------------------------------------------------------------
// Custom functions – Telegram commands + optional threshold monitors, defined
// in the admin panel. Each API returns one number (a field, an item count or a sum).
// ---------------------------------------------------------------------------
const OPS = {
  '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b,
  '>=': (a, b) => a >= b, '==': (a, b) => a === b, '!=': (a, b) => a !== b,
};

const getPath = (obj, p) => (p ? p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj) : obj);

// query values may use {now} {today} {1h_ago} {24h_ago}
function fillPlaceholders(s) {
  const now = new Date();
  const values = {
    now: now.toISOString(),
    today: now.toLocaleDateString('en-CA', { timeZone: cfg.timezone }),
    '1h_ago': new Date(now - 3600e3).toISOString(),
    '24h_ago': new Date(now - 86400e3).toISOString(),
  };
  return s.replace(/\{(now|today|1h_ago|24h_ago)\}/g, (_, k) => values[k]);
}

function customParams(api, arg) {
  const params = Object.fromEntries(new URLSearchParams(api.query || ''));
  for (const k of Object.keys(params)) params[k] = fillPlaceholders(params[k]);
  if (api.argParam && arg) params[api.argParam] = arg;
  return params;
}

function extractValue(api, data) {
  if (api.valueMode === 'count' || api.valueMode === 'sum') {
    const target = api.valuePath ? getPath(data, api.valuePath) : data;
    const items = Array.isArray(target) ? target : extractList(target);
    if (api.valueMode === 'count') return items.length;
    return items.reduce((sum, r) => sum + (Number(getPath(r, api.sumField)) || 0), 0);
  }
  const v = Number(getPath(data, api.valuePath));
  if (!Number.isFinite(v)) throw new Error(`"${api.valuePath}" is not a number in the API response`);
  return v;
}

async function runCustomApi(fn, api, arg) {
  const res = await apiRequest(fn, api, customParams(api, arg));
  return extractValue(api, res.data);
}

const fmtValue = (fn, v) => (fn.format === 'inr' ? inr(v) : Number(v).toLocaleString('en-IN'));
const condText = (fn) => `value ${fn.monitor.op} ${fmtValue(fn, fn.monitor.threshold)}`;
const isTriggered = (fn, v) => !!OPS[fn.monitor?.op]?.(v, Number(fn.monitor.threshold));

async function runFunctionCommand(msg, fn, arg) {
  const apis = fn.apis.filter((a) => a.enabled);
  if (!apis.length) return send(msg.chat.id, `⚠️ <b>${esc(fn.name)}</b> has no APIs configured.`);
  const lines = await Promise.all(apis.map(async (api) => {
    const prefix = apis.length > 1 ? `• ${esc(api.name)}: ` : 'Value: ';
    try {
      const v = await runCustomApi(fn, api, arg);
      const flag = fn.monitor?.enabled ? (isTriggered(fn, v) ? ' 🔴' : ' 🟢') : '';
      return `${prefix}<b>${fmtValue(fn, v)}</b>${flag}`;
    } catch (e) {
      return `${prefix}❌ <code>${esc(e.response ? `HTTP ${e.response.status}` : e.message)}</code>`;
    }
  }));
  return send(msg.chat.id,
    `📊 <b>${esc(fn.name)}</b>${arg ? ` – ${esc(arg)}` : ''}\n${lines.join('\n')}` +
    (fn.monitor?.enabled ? `\n<i>Alerts when ${esc(condText(fn))}</i>` : '') +
    `\n<i>As of ${fmtTime(Date.now())}</i>`);
}

// monitor: alert once when the condition becomes true, remind, and send recovery
async function checkFunction(fn) {
  const now = Date.now();
  state.fnAlerts ||= {};
  state.fnLastRun ||= {};
  state.fnLastRun[fn.id] = now;
  const apis = fn.apis.filter((a) => a.enabled);
  for (const api of apis) {
    const key = `${fn.id}:${api.id}`;
    let v;
    try {
      v = await runCustomApi(fn, api);
      await trackApiHealth({ id: key, name: `${fn.name} – ${api.name}` }, true);
    } catch (e) {
      await trackApiHealth({ id: key, name: `${fn.name} – ${api.name}` }, false, e);
      continue;
    }
    const active = state.fnAlerts[key];
    const apiLine = apis.length > 1 ? `API: ${esc(api.name)}\n` : '';
    if (isTriggered(fn, v)) {
      const remindMs = (fn.monitor.remindMin || 0) * 60000;
      if (!active || (remindMs > 0 && now - active.lastAlert >= remindMs)) {
        await notify(
          `${active ? '🔁' : '⚠️'} <b>${esc(fn.name)}</b>${active ? ' (reminder)' : ''}\n` + apiLine +
          `Value: <b>${fmtValue(fn, v)}</b>\nAlert when: ${esc(condText(fn))}` +
          (active ? `\nSince: ${fmtTime(active.since)}` : ''));
        state.fnAlerts[key] = { since: active?.since || now, lastAlert: now, value: v };
      } else {
        active.value = v;
      }
    } else if (active) {
      await notify(`✅ <b>${esc(fn.name)}</b> back to normal\n` + apiLine + `Value: <b>${fmtValue(fn, v)}</b>`);
      delete state.fnAlerts[key];
    }
  }
  saveState();
}

const fnRunning = new Set();

function functionsTick() {
  const fns = config.customFunctions();
  // forget alerts of deleted/disabled functions and APIs
  const live = new Set(fns.filter((f) => f.enabled && f.monitor?.enabled).flatMap((f) => f.apis.filter((a) => a.enabled).map((a) => `${f.id}:${a.id}`)));
  for (const k of Object.keys(state.fnAlerts || {})) if (!live.has(k)) delete state.fnAlerts[k];

  for (const fn of fns) {
    if (!fn.enabled || !fn.monitor?.enabled || fnRunning.has(fn.id)) continue;
    if (Date.now() - (state.fnLastRun?.[fn.id] || 0) < fn.monitor.everyMin * 60000) continue;
    fnRunning.add(fn.id);
    checkFunction(fn)
      .catch((e) => console.error(`Function ${fn.name} crashed:`, e))
      .finally(() => fnRunning.delete(fn.id));
  }
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

// Built-in commands: names, descriptions and on/off come from the admin panel (Commands tab)
const activeBuiltinCommands = () => config.commands().filter((c) => c.enabled);
const activeCustomFunctions = () => config.customFunctions().filter((f) => f.enabled);
const cmd = (key) => '/' + (config.commands().find((c) => c.key === key)?.command || key);

// /help – generated from whatever is active right now
function helpText() {
  const builtins = activeBuiltinCommands().map((c) => `/${c.command} – ${esc(c.description)}`);
  const fns = activeCustomFunctions().map((f) => `/${f.command} – ${esc(f.description || f.name)}`);
  return `<b>Commands</b>\n${builtins.join('\n')}` + (fns.length ? `\n\n<b>Functions</b>\n${fns.join('\n')}` : '');
}

// keep Telegram's "/" command menu in sync with the active commands
function syncBotCommands() {
  if (!bot) return;
  const commands = [
    ...activeBuiltinCommands().map((c) => ({ command: c.command, description: c.description.slice(0, 256) })),
    ...activeCustomFunctions().map((f) => ({ command: f.command, description: (f.description || f.name).slice(0, 256) })),
  ];
  bot.setMyCommands(commands).catch((e) => console.error('Could not update bot command menu:', e.message));
}

// access check + logging for every command
async function guarded(msg, handler) {
  trackMessage(msg.chat.id, msg.message_id, msg.date * 1000);
  if (!isAllowed(msg)) {
    console.warn(`[DENIED] ${who(msg)}: ${msg.text}`);
    recordAccessRequest(msg);
    const idCmd = activeBuiltinCommands().find((c) => c.key === 'id');
    return send(msg.chat.id, `⛔ Not authorised. ${idCmd ? `Send /${idCmd.command} and ask` : "Ask"} the admin to give you access.`);
  }
  console.log(`[CMD] ${who(msg)}: ${msg.text}`);
  try {
    await handler();
  } catch (e) {
    console.error(`[CMD] ${msg.text} failed:`, e.message);
    await send(msg.chat.id, `Error: ${esc(e.message)}`);
  }
}

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

// What each built-in command does, by key (its /name is configurable)
const COMMAND_HANDLERS = {
  help: (msg) => send(msg.chat.id, helpText()),

  status: (msg) => {
    const apis = config.get().functions.map((f) => {
      const rows = f.apis.map((a) => {
        const errs = state.apiErrors[f.builtin ? a.id : `${f.id}:${a.id}`];
        return `   • ${esc(a.name)}${a.enabled ? '' : ' – disabled'}${errs ? ` – ${errs} error(s)` : ''}`;
      });
      const alerts = Object.keys(state.fnAlerts || {}).filter((k) => k.startsWith(f.id + ':')).length;
      return `${f.enabled ? '🟢' : '⚪️'} ${esc(f.name)}${f.builtin ? '' : ` (/${f.command})`}${alerts ? ` – ${alerts} alert(s) active` : ''}\n` +
        (rows.join('\n') || '   • no APIs');
    }).join('\n');
    const ac = config.get().autoClear;
    return send(msg.chat.id,
      `<b>Status</b>\n` +
      `Last balance check: ${state.lastBalanceCheck ? fmtTime(state.lastBalanceCheck) : 'never'}\n` +
      `Last txn check: ${state.lastTxnCheck ? fmtTime(state.lastTxnCheck) : 'never'}\n\n` +
      `<b>Functions</b>\n${apis}\n\n` +
      `Balance threshold: ${inr(cfg.balanceThreshold)} (${lakh(cfg.balanceThreshold)})\n` +
      `Failure alert after: ${cfg.failThreshold} consecutive fails\n` +
      `Accounts tracked: ${Object.keys(state.balances).length}\n` +
      `Blocked accounts: ${access.blockedAccounts.length} · Inactive accounts: ${cfg.skipInactive ? 'skipped' : 'checked'}\n` +
      `Low balance now: ${Object.keys(state.lowBalance).length}\n` +
      `Active failure streaks: ${Object.values(state.streaks).filter((s) => s.count > 0).length}\n` +
      `Chat auto-clear: ${ac.enabled ? (ac.mode === 'daily' ? `daily at ${ac.time}` : 'continuous') + `, older than ${ac.olderThanHours}h` : 'off'}`
    );
  },

  // /bal <account no | last digits | name | bank | id>  -> live lookup
  bal: (msg, arg) => {
    const q = arg.toLowerCase();
    if (!q) return send(msg.chat.id, `Usage: <code>${cmd('bal')} &lt;account number / last 4 digits / name&gt;</code>\nExample: <code>${cmd('bal')} 7854</code>`);
    return balanceLookup(msg, q);
  },

  // /balance -> all accounts · /balance <search> -> specific account (live)
  balance: (msg, arg) => {
    const q = arg.toLowerCase();
    if (q) return balanceLookup(msg, q);
    const rows = Object.values(state.balances).sort((a, b) => a.balance - b.balance);
    if (!rows.length) return send(msg.chat.id, 'No balance data yet.');
    const text = rows.map((a) =>
      `${a.balance < cfg.balanceThreshold ? '🔴' : '🟢'} <b>${esc(a.customerName || '-')}</b> | ${esc(a.bankName || '-')} | <code>${esc(a.accountNumber)}</code> | ${inr(a.balance)}`
    ).join('\n');
    return send(msg.chat.id, `<b>Balances</b> (lowest first)\n\n${text}`);
  },

  low: (msg) => {
    const rows = Object.entries(state.lowBalance);
    if (!rows.length) return send(msg.chat.id, '✅ All accounts above threshold.');
    const text = rows.map(([id, l]) => {
      const a = state.balances[id] || {};
      return `🔴 <b>${esc(a.customerName || '-')}</b> | ${esc(a.bankName || '-')} | <code>${esc(a.accountNumber || id)}</code> | ${inr(l.balance)} | since ${fmtTime(l.since)}`;
    }).join('\n');
    return send(msg.chat.id, `<b>Low Balance Accounts</b>\n\n${text}`);
  },

  failures: (msg) => {
    const rows = Object.entries(state.streaks).filter(([, s]) => s.count > 0).sort((a, b) => b[1].count - a[1].count);
    if (!rows.length) return send(msg.chat.id, '✅ No active failure streaks.');
    const text = rows.map(([id, s]) =>
      `${s.count >= cfg.failThreshold ? '🚨' : '⚠️'} ${custLabel(s.customerName, id)} – ${s.count} in a row` +
      (s.recent.at(-1)?.reason ? ` (last: ${esc(s.recent.at(-1).reason)})` : '')
    ).join('\n');
    return send(msg.chat.id, `<b>Failure Streaks</b>\n\n${text}`);
  },

  check: async (msg) => {
    await send(msg.chat.id, '⏳ Running checks...');
    await Promise.all([checkBalances(), checkTransactions()]);
    await send(msg.chat.id, `✅ Checks complete. Use ${cmd('status')} for details.`);
  },

  clear: async (msg) => {
    const r = await clearChats({ chatId: msg.chat.id, reason: `${cmd('clear')} by ${who(msg)}` });
    if (r.failed) await send(msg.chat.id, `🧹 Cleared ${r.deleted} message(s). ${r.failed} could not be deleted (older than 48h, or the bot is not a group admin).`);
  },

  id: (msg) => send(msg.chat.id, `Chat ID: <code>${msg.chat.id}</code>\nYour user ID: <code>${msg.from?.id}</code>`),
};

// One dispatcher for every command – looks up the current names per message,
// so renaming or switching commands on/off in the admin panel works immediately.
function registerHandlers(b) {
  b.onText(/^\/([A-Za-z0-9_]{1,32})(?:@(\w+))?(?:\s+([\s\S]+))?$/, (msg, match) => {
    const name = match[1].toLowerCase();
    if (match[2] && botInfo && match[2].toLowerCase() !== botInfo.username.toLowerCase()) return; // /cmd@OtherBot
    const arg = (match[3] || '').trim();

    const builtin = name === 'start'
      ? config.commands().find((c) => c.key === 'help')
      : activeBuiltinCommands().find((c) => c.command === name);

    // the ID command works for everyone, so new chats/users can find their IDs
    if (builtin?.key === 'id') {
      trackMessage(msg.chat.id, msg.message_id, msg.date * 1000);
      if (!isAllowed(msg)) recordAccessRequest(msg);
      return COMMAND_HANDLERS.id(msg);
    }
    if (builtin) return guarded(msg, () => COMMAND_HANDLERS[builtin.key](msg, arg));

    const fn = activeCustomFunctions().find((f) => f.command === name);
    if (fn) return guarded(msg, () => runFunctionCommand(msg, fn, arg));
    // anything else (unknown or switched-off command) is ignored
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
  syncBotCommands();
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

if (!endpointsOf('balance').length) console.warn('⚠ No balance API configured – add one in the admin panel (Functions tab)');
if (!endpointsOf('transactions').length) console.warn('⚠ No transactions API configured – add one in the admin panel (Functions tab)');

schedule('balance', checkBalances, cfg.balancePollSec);
schedule('transactions', checkTransactions, cfg.txnPollSec);
setInterval(functionsTick, 20 * 1000);
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
    if (!endpointsOf('balance').length) throw new Error('No enabled balance API – add one in Functions → Balance check');
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
    view: () => ({ telegram: config.publicTelegram(), bot: botInfo, timezone: cfg.timezone }),
    setBotToken: changeBotToken,
  },

  webhooks: {
    receive: receiveWebhook,
    view: () => ({
      webhooks: config.webhooks(),
      deliveries: Object.fromEntries(config.webhooks().map((w) => [w.id, deliveries.get(w.id) || []])),
      defaults: config.defaultWebhookStatuses(),
    }),
    upsert: (data) => { const id = config.upsertWebhook(data); refreshSecrets(); return id; },
    remove: (id) => { config.deleteWebhook(id); deliveries.delete(id); delete state.whStreaks?.[id]; saveState(); refreshSecrets(); },
    regenerateSecret: (id) => { config.regenerateWebhookSecret(id); refreshSecrets(); },
    test: sendWebhookTest,
  },

  commands: {
    view: () => ({
      commands: config.commands(),
      functions: config.customFunctions().map((f) => ({ id: f.id, name: f.name, command: f.command, description: f.description, enabled: f.enabled })),
      help: helpText(),
    }),
    update: (key, data) => { const c = config.updateCommand(key, data); syncBotCommands(); return c; },
    setFunctionEnabled: (id, enabled) => { config.setFunctionEnabled(id, enabled); syncBotCommands(); },
  },

  functions: {
    view: () => ({ functions: config.publicFunctions(), activeAlerts: state.fnAlerts || {}, lastRun: state.fnLastRun || {} }),
    upsert: (data) => { const id = config.upsertFunction(data); refreshSecrets(); syncBotCommands(); return id; },
    remove: (id) => { config.deleteFunction(id); refreshSecrets(); syncBotCommands(); },
    upsertApi: (fnId, data) => { const id = config.upsertApi(fnId, data); refreshSecrets(); return id; },
    removeApi: (fnId, apiId) => { config.deleteApi(fnId, apiId); refreshSecrets(); },

    // call an API once and report what came back
    async testApi(fnId, apiId) {
      const fn = config.fn(fnId);
      const api = fn?.apis.find((a) => a.id === apiId);
      if (!api) throw new Error('API not found');
      const started = Date.now();
      const params = fn.builtin === 'transactions' ? txnParams(api, started) : fn.builtin ? undefined : customParams(api);
      const res = await apiRequest(fn, api, params);
      const items = extractList(res.data);
      const sample = items[0] || (res.data && typeof res.data === 'object' ? res.data : {});
      const out = { status: res.status, ms: Date.now() - started, items: items.length, fields: Object.keys(sample).slice(0, 25) };
      if (!fn.builtin) out.value = fmtValue(fn, extractValue(api, res.data));
      return out;
    },

    // run a custom function's monitor now
    async runNow(fnId) {
      const fn = config.fn(fnId);
      if (!fn || fn.builtin) throw new Error('Function not found');
      if (!fn.monitor?.enabled) throw new Error('Turn on alerts for this function first (or use Test on an API)');
      if (fnRunning.has(fn.id)) throw new Error('This function is already running');
      fnRunning.add(fn.id);
      try { await checkFunction(fn); } finally { fnRunning.delete(fn.id); }
      return state.fnAlerts || {};
    },
  },
});

const shutdown = () => { saveState(); console.log('State saved. Bye.'); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('🟢 Monitoring service started');
