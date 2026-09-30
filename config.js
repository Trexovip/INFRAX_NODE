  /**
   * Bot configuration managed from the admin panel:
   * - Telegram bot token
   * - Functions: each has a master key and one or more APIs. Every API uses the
   *   function's master key, its own key, or no key.
   *   - built-in "balance" / "transactions" functions power the balance & failure monitors
   *   - custom functions add a Telegram command (e.g. /trxn_wezbo) and an optional
   *     monitor that alerts when the API value crosses a threshold
   * - Chat auto-clear schedule
   * Stored in CONFIG_FILE. Seeded from .env on first run.
   */
  const fs = require('fs');
  const crypto = require('crypto');

  const newId = () => crypto.randomBytes(4).toString('hex');
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const HEADER_RE = /^[A-Za-z0-9-]{0,60}$/;
  const OPS = ['<', '<=', '>', '>=', '==', '!='];
  // Built-in bot commands. Name, description and on/off are editable in the admin panel;
  // `key` identifies what the command does and never changes.
  const BUILTIN_COMMANDS = [
    { key: 'help', command: 'help', description: 'Show all commands', what: 'Lists every active command (also answers /start)', locked: true },
    { key: 'status', command: 'status', description: 'Bot health & thresholds', what: 'Last checks, functions/APIs, thresholds, auto-clear' },
    { key: 'balance', command: 'balance', description: 'All account balances (or add a search)', what: 'All tracked balances, lowest first; with text it searches' },
    { key: 'bal', command: 'bal', description: 'Live balance of an account – e.g. 7854 or a name', what: 'Live lookup by account number, last digits, name or bank' },
    { key: 'low', command: 'low', description: 'Accounts below threshold', what: 'Accounts currently under the low-balance threshold' },
    { key: 'failures', command: 'failures', description: 'Customers with failed / pending transactions in a row', what: 'Customers whose latest vendor transactions are failed or pending in a row' },
    { key: 'check', command: 'check', description: 'Run the balance check now', what: 'Runs the balance check immediately' },
    { key: 'clear', command: 'clear', description: "Delete the bot's messages in this chat", what: 'Deletes bot messages (under 48h) in the current chat' },
    { key: 'id', command: 'id', description: 'Show chat/user ID', what: 'Replies with the chat ID and user ID – works for everyone, even without access' },
  ];

  const emptyKey = () => ({ key: '', secret: '', keyHeader: 'x-trexo-key', secretHeader: 'x-trexo-secret' });
  const pickKey = (c) => ({ key: c.key || '', secret: c.secret || '', keyHeader: c.keyHeader ?? 'x-trexo-key', secretHeader: c.secretHeader ?? 'x-trexo-secret' });

  function mask(s) {
    s = String(s || '');
    if (!s) return '';
    return s.length <= 8 ? '••••' : `${s.slice(0, 4)}••••${s.slice(-4)}`;
  }

  function maskToken(t) {
    t = String(t || '');
    if (!t) return '';
    return `${t.split(':')[0]}:••••${t.slice(-4)}`;
  }

  function newApi(data = {}) {
    return {
      id: data.id || newId(), name: '', url: '', enabled: true,
      keyMode: 'master', ...emptyKey(),
      method: 'GET', query: '', argParam: '', sinceParam: '',
      valueMode: 'path', valuePath: '', sumField: '',
      ...data,
    };
  }

  function builtinFunctions() {
    return [
      { id: 'balance', builtin: 'balance', name: 'Balance check', command: 'bal', description: 'Low-balance alerts · /bal, /balance, /low', enabled: true, master: emptyKey(), apis: [] },
      { id: 'transactions', builtin: 'transactions', name: 'Transaction failures', command: 'failures', description: 'Vendor sends failed & pending transactions · alerts after N in a row · /failures', enabled: true, master: emptyKey(), apis: [] },
    ];
  }


  // incoming transactions (vendor → bot) for the built-in Transaction failures function
  const DEFAULT_INBOX_STATUSES = {
    failed: 'FAILED,FAILURE,DECLINED,REJECTED,ERROR',
    pending: 'PENDING,PROCESSING,INITIATED,IN_PROGRESS,CREATED,SUBMITTED',
    success: 'SUCCESS,SUCCESSFUL,COMPLETED,SETTLED',
  };
  const defaultInbox = () => ({
    token: crypto.randomBytes(16).toString('hex'), // the URL's random part – the only protection (no secret)
    failedInRow: 5,
    pendingInRow: 5,
    statuses: { ...DEFAULT_INBOX_STATUSES },
  });

  function seedFromEnv(env) {
    const fns = builtinFunctions();
    const master = { ...emptyKey(), key: env.TREXO_KEY || '', secret: env.TREXO_SECRET || '' };
    fns[0].master = { ...master };
    fns[1].master = { ...master };
    if (env.BALANCE_API_URL) fns[0].apis.push(newApi({ id: 'balance', name: 'Balances', url: env.BALANCE_API_URL }));
    return fns;
  }

  // older config.json had a shared credentials list + endpoints
  function migrateEndpoints(old) {
    const fns = builtinFunctions();
    const creds = old.credentials || [];
    for (const fn of fns) {
      const eps = (old.endpoints || []).filter((e) => e.type === fn.builtin);
      const masterCred = creds.find((c) => c.id === eps[0]?.credentialId) || creds[0];
      if (masterCred) fn.master = pickKey(masterCred);
      fn.apis = eps.map((e) => {
        const c = creds.find((x) => x.id === e.credentialId);
        const keyMode = !c ? 'none' : c === masterCred ? 'master' : 'own';
        return newApi({
          id: e.id, name: e.name, url: e.url, enabled: e.enabled !== false, sinceParam: e.sinceParam || '',
          keyMode, ...(keyMode === 'own' ? pickKey(c) : emptyKey()),
        });
      });
    }
    return fns;
  }

  function createConfigStore({ file, env, writeJson }) {
    let config = {
      telegram: { botToken: env.TELEGRAM_BOT_TOKEN || '' },
      functions: seedFromEnv(env),
      autoClear: { enabled: true, mode: 'rolling', time: '03:00', olderThanHours: 24 },
    };
    try {
      if (fs.existsSync(file)) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!saved.functions && saved.endpoints) saved.functions = migrateEndpoints(saved);
        delete saved.credentials;
        delete saved.endpoints;
        config = { ...config, ...saved };
      }
    } catch (e) {
      console.error('Could not read config file, using .env values:', e.message);
    }
    // built-in functions always exist
    for (const b of builtinFunctions()) if (!config.functions.some((f) => f.id === b.id)) config.functions.unshift(b);
    // Transaction failures no longer polls an API – the vendor pushes transactions to its incoming URL
    const txFn = config.functions.find((f) => f.id === 'transactions');
    txFn.apis = [];
    if (/^Consecutive failure alerts/.test(txFn.description || '')) txFn.description = builtinFunctions()[1].description;
    txFn.inbox = { ...defaultInbox(), ...(txFn.inbox || {}) };

    const save = () => {
      try { writeJson(file, config); } catch (e) { console.error('Failed to save config file:', e.message); }
    };
    save();

    const text = (v, max, field) => {
      const s = String(v ?? '').trim();
      if (s.length > max) throw new Error(`${field} is too long`);
      return s;
    };
    const num = (v, field, { min = -Infinity, max = Infinity, int = false } = {}) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw new Error(`${field} must be a ${int ? 'whole ' : ''}number${Number.isFinite(min) ? ` from ${min}` : ''}${Number.isFinite(max) ? ` to ${max}` : ''}`);
      return n;
    };
    const header = (v, fallback, field) => {
      const h = text(v ?? fallback, 60, field);
      if (!HEADER_RE.test(h)) throw new Error(`${field} may only contain letters, digits and -`);
      return h;
    };
    // blank key/secret keeps the stored value
    const keyFields = (data, existing) => ({
      key: text(data.key, Infinity, 'Key') || existing?.key || '',
      secret: text(data.secret, Infinity, 'Secret') || existing?.secret || '',
      keyHeader: header(data.keyHeader, existing?.keyHeader ?? 'x-trexo-key', 'Key header'),
      secretHeader: header(data.secretHeader, existing?.secretHeader ?? 'x-trexo-secret', 'Secret header'),
    });
    const findFn = (id) => {
      const fn = config.functions.find((f) => f.id === id);
      if (!fn) throw new Error('Function not found');
      return fn;
    };

    // built-in commands merged with the admin's overrides
    const commands = () => BUILTIN_COMMANDS.map((d) => {
      const saved = config.commands?.[d.key] || {};
      return {
        key: d.key, what: d.what, locked: !!d.locked, defaultCommand: d.command,
        command: saved.command || d.command,
        description: saved.description || d.description,
        enabled: d.locked ? true : saved.enabled !== false,
      };
    });

    // is /name free? (built-in names count even when switched off)
    const assertCommandFree = (name, { key, fnId } = {}) => {
      if (name === 'start') throw new Error('/start is reserved (it shows the help)');
      const b = commands().find((c) => c.command === name && c.key !== key);
      if (b) throw new Error(`/${name} is already used by the built-in “${b.what}” command`);
      const f = config.functions.find((x) => !x.builtin && x.command === name && x.id !== fnId);
      if (f) throw new Error(`/${name} is already used by the function “${f.name}”`);
    };

    const keyView = (k) =>({ keyHeader: k.keyHeader, secretHeader: k.secretHeader, keyHint: mask(k.key), secretHint: mask(k.secret) });

    return {
      get: () => config,
      fn: (id) => config.functions.find((f) => f.id === id) || null,
      customFunctions: () => config.functions.filter((f) => !f.builtin),

      // headers for one API call: its own key, the function's master key, or none
      authHeaders(fn, api) {
        const k = api.keyMode === 'own' ? api : api.keyMode === 'master' ? fn.master : null;
        const headers = {};
        if (k?.keyHeader && k.key) headers[k.keyHeader] = k.key;
        if (k?.secretHeader && k.secret) headers[k.secretHeader] = k.secret;
        return headers;
      },

      // every secret value, so the logger can mask them
      secrets: () => [
        config.telegram.botToken,
        config.functions.find((f) => f.id === 'transactions')?.inbox?.token,
        ...config.functions.flatMap((f) => [f.master?.key, f.master?.secret, ...f.apis.flatMap((a) => [a.key, a.secret])]),
      ],

      // safe to send to the browser: secrets masked
      publicTelegram: () => ({ configured: !!config.telegram.botToken, tokenHint: maskToken(config.telegram.botToken) }),
      publicFunctions: () => config.functions.map((f) => ({
        ...f,
        master: keyView(f.master || emptyKey()),
        apis: f.apis.map(({ key, secret, ...a }) => ({ ...a, ...keyView({ key, secret, keyHeader: a.keyHeader, secretHeader: a.secretHeader }) })),
      })),

      setBotToken(token) {
        token = String(token || '').trim();
        if (!/^\d{5,20}:[A-Za-z0-9_-]{30,60}$/.test(token)) throw new Error('That does not look like a Telegram bot token (123456:ABC…)');
        config.telegram = { ...config.telegram, botToken: token };
        save();
      },

      upsertFunction(data) {
        const existing = data.id ? findFn(data.id) : null;
        const name = text(data.name, 60, 'Name');
        if (!name) throw new Error('Name is required');
        const entry = {
          name,
          description: text(data.description, 200, 'Description'),
          enabled: data.enabled !== false,
          master: keyFields(data.master || {}, existing?.master),
        };

        if (!existing?.builtin) {
          const command = text(data.command, 32, 'Command').replace(/^\//, '').toLowerCase();
          if (!/^[a-z0-9_]{1,32}$/.test(command)) throw new Error('Command may only use a–z, 0–9 and _ (e.g. trxn_wezbo)');
          assertCommandFree(command, { fnId: existing?.id });
          const m = data.monitor || {};
          if (!OPS.includes(m.op || '<')) throw new Error('Invalid condition');
          Object.assign(entry, {
            command,
            format: data.format === 'inr' ? 'inr' : 'number',
            monitor: {
              enabled: m.enabled === true,
              everyMin: num(m.everyMin ?? 5, 'Check every (minutes)', { min: 1, max: 1440, int: true }),
              op: m.op || '<',
              threshold: num(m.threshold ?? 0, 'Threshold'),
              remindMin: num(m.remindMin ?? 60, 'Remind every (minutes)', { min: 0, max: 10080, int: true }),
            },
          });
        }

        if (existing) {
          Object.assign(existing, entry);
        } else {
          config.functions.push({ id: newId(), builtin: null, apis: [], ...entry });
        }
        save();
        return existing?.id || config.functions.at(-1).id;
      },

      setFunctionEnabled(id, enabled) {
        if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
        findFn(id).enabled = enabled;
        save();
      },

      commands,

      updateCommand(key, data) {
        const current = commands().find((c) => c.key === key);
        if (!current) throw new Error('Unknown command');
        const command = text(data.command ?? current.command, 32, 'Command').replace(/^\//, '').toLowerCase();
        if (!/^[a-z0-9_]{1,32}$/.test(command)) throw new Error('Command may only use a–z, 0–9 and _');
        assertCommandFree(command, { key });
        const description = text(data.description ?? current.description, 200, 'Description');
        if (!description) throw new Error('Description is required (it is shown in /help)');
        const enabled = current.locked ? true : data.enabled ?? current.enabled;
        if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
        config.commands = { ...(config.commands || {}), [key]: { command, description, enabled } };
        save();
        return commands().find((c) => c.key === key);
      },

      deleteFunction(id) {
        const fn = findFn(id);
        if (fn.builtin) throw new Error('Built-in functions cannot be deleted (you can disable them)');
        config.functions = config.functions.filter((f) => f.id !== id);
        save();
      },

      // --- incoming transactions (Transaction failures) ---
      inbox: () => config.functions.find((f) => f.id === 'transactions').inbox,
      defaultInboxStatuses: () => ({ ...DEFAULT_INBOX_STATUSES }),

      updateInbox(data) {
        const fn = findFn('transactions');
        const statuses = {};
        for (const k of Object.keys(DEFAULT_INBOX_STATUSES)) {
          statuses[k] = text(data.statuses?.[k] ?? fn.inbox.statuses[k], 500, `${k} statuses`).toUpperCase().replace(/\s+/g, '');
        }
        fn.inbox = {
          ...fn.inbox,
          failedInRow: num(data.failedInRow ?? fn.inbox.failedInRow, 'Failed in a row', { min: 0, max: 50, int: true }),
          pendingInRow: num(data.pendingInRow ?? fn.inbox.pendingInRow, 'Pending in a row', { min: 0, max: 50, int: true }),
          statuses,
        };
        save();
        return fn.inbox;
      },

      regenerateInboxToken() {
        const fn = findFn('transactions');
        fn.inbox = { ...fn.inbox, token: defaultInbox().token };
        save();
        return fn.inbox;
      },

      upsertApi(fnId, data) {
        const fn = findFn(fnId);
        if (fn.builtin === 'transactions') throw new Error('Transaction failures has no APIs – your vendor sends transactions to its incoming URL');
        const existing = data.id ? fn.apis.find((a) => a.id === data.id) : null;
        if (data.id && !existing) throw new Error('API not found');
        const name = text(data.name, 60, 'Name');
        if (!name) throw new Error('Name is required');
        const url = text(data.url, 500, 'URL');
        let parsed;
        try { parsed = new URL(url); } catch { throw new Error('Enter a valid URL'); }
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('URL must start with http:// or https://');
        const keyMode = ['master', 'own', 'none'].includes(data.keyMode) ? data.keyMode : 'master';
        const param = (v, field) => {
          const s = text(v, 60, field);
          if (!/^[A-Za-z0-9_.\-[\]]*$/.test(s)) throw new Error(`Invalid ${field}`);
          return s;
        };

        const entry = newApi({
          ...(existing || {}),
          name, url, keyMode,
          enabled: data.enabled !== false,
          ...(keyMode === 'own' ? keyFields(data, existing) : { ...emptyKey(), key: '', secret: '' }),
        });
        if (!fn.builtin) {
          entry.method = data.method === 'POST' ? 'POST' : 'GET';
          entry.query = text(data.query, 500, 'Query parameters');
          entry.argParam = param(data.argParam, 'argument parameter');
          entry.valueMode = ['path', 'count', 'sum'].includes(data.valueMode) ? data.valueMode : 'path';
          entry.valuePath = text(data.valuePath, 200, 'Value path');
          entry.sumField = text(data.sumField, 200, 'Sum field');
          if (entry.valueMode === 'path' && !entry.valuePath) throw new Error('Enter the field that holds the value (e.g. data.count)');
          if (entry.valueMode === 'sum' && !entry.sumField) throw new Error('Enter the field to add up (e.g. amount)');
        }

        if (existing) Object.assign(existing, entry);
        else fn.apis.push(entry);
        save();
        return entry.id;
      },

      deleteApi(fnId, apiId) {
        const fn = findFn(fnId);
        const before = fn.apis.length;
        fn.apis = fn.apis.filter((a) => a.id !== apiId);
        if (fn.apis.length === before) throw new Error('API not found');
        save();
      },

      setAutoClear({ enabled, mode, time, olderThanHours }) {
        if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
        if (!['rolling', 'daily'].includes(mode)) throw new Error('Mode must be rolling or daily');
        if (!TIME_RE.test(String(time))) throw new Error('Time must be HH:MM (24-hour)');
        // Telegram refuses to delete messages older than 48 hours
        const hours = num(olderThanHours, 'Hours', { min: mode === 'rolling' ? 1 : 0, max: 47, int: true });
        config.autoClear = { enabled, mode, time, olderThanHours: hours };
        save();
        return config.autoClear;
      },
    };
  }

  module.exports = { createConfigStore, OPS };
