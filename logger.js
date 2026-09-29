/**
 * Captures console output into an in-memory buffer (for the admin panel) and a
 * JSON-lines log file (so logs survive restarts). Secrets are redacted.
 */
const fs = require('fs');
const util = require('util');

const MAX_MEMORY = 2000;
const LEVELS = { log: 'info', info: 'info', warn: 'warn', error: 'error' };

const entries = [];
let seq = 0;
let file = null;
let maxBytes = 5 * 1024 * 1024;
let secrets = [];

function redact(text) {
  for (const s of secrets) text = text.split(s).join('***');
  return text;
}

function add(level, args) {
  const entry = { seq: ++seq, ts: Date.now(), level, text: redact(util.format(...args)) };
  entries.push(entry);
  if (entries.length > MAX_MEMORY) entries.splice(0, entries.length - MAX_MEMORY);
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    if (fs.statSync(file).size > maxBytes) fs.renameSync(file, file + '.1'); // keep one rotated file
  } catch {
    // never let logging crash the bot
  }
}

function loadExisting() {
  const lines = [];
  for (const f of [file + '.1', file]) {
    try { lines.push(...fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)); } catch { /* missing file */ }
  }
  for (const line of lines.slice(-MAX_MEMORY)) {
    try {
      const e = JSON.parse(line);
      entries.push(e);
      seq = Math.max(seq, e.seq || 0);
    } catch { /* skip corrupt line */ }
  }
}

// values to mask as *** in every log line (call again whenever secrets change)
function setSecrets(list) {
  secrets = (list || []).filter((s) => s && String(s).length >= 6).map(String);
}

function init(opts = {}) {
  file = opts.file || null;
  if (opts.maxBytes) maxBytes = opts.maxBytes;
  setSecrets(opts.redact);
  if (file) loadExisting();

  for (const [method, level] of Object.entries(LEVELS)) {
    const original = console[method].bind(console);
    console[method] = (...args) => { original(...args); add(level, args); };
  }
}

// after: only entries newer than this seq (for live polling)
function query({ after = 0, level = '', q = '', limit = 500 } = {}) {
  const needle = q.toLowerCase();
  const out = entries.filter((e) =>
    e.seq > after &&
    (!level || e.level === level) &&
    (!needle || e.text.toLowerCase().includes(needle)));
  return { entries: out.slice(-limit), lastSeq: seq };
}

module.exports = { init, query, setSecrets };
