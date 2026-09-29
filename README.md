# Internal Monitoring Telegram Bot

## Setup
1. Create a bot with @BotFather and copy the token.
2. Add the bot to your internal alerts group (make it an admin with “Delete messages” if you want chat clearing to remove commands too).
3. `npm install`
4. Create `.env` with at least:
   ```
   ADMIN_USER=admin
   ADMIN_PASSWORD=choose-a-strong-password
   ```
5. `npm start`, open http://localhost:3000 and sign in.
6. **Settings** tab: paste the bot token. **Functions** tab: set the master key and add APIs to *Balance check* and *Transaction failures*, and create your own functions.
7. Send `/id` in the group and add that chat under **Access → Alert chats** (or approve it from Access requests).

Existing `.env` values (`TELEGRAM_BOT_TOKEN`, `TREXO_KEY`, `TREXO_SECRET`, `BALANCE_API_URL`, `TXN_API_URL`, `ALERT_CHAT_IDS`, `ALLOWED_USER_IDS`) are imported automatically on first start. After that the admin panel is the source of truth.

## Data files
Everything the panel changes is stored in `DATA_DIR` (default: the project folder):

| File | Contents |
|---|---|
| `config.json` | bot token, functions (APIs and keys), auto-clear settings – **contains secrets** |
| `access.json` | alert chats, allowed users, blocked accounts, access requests |
| `state.json` | alert state, balances, message IDs for chat clearing |
| `logs.jsonl` | logs shown in the Logs tab |

These are in `.gitignore` – never commit them. On Railway, add a Volume mounted at `/data` and set `DATA_DIR=/data`, otherwise everything is lost on each deploy.

## Admin panel
Environment variables (these stay in `.env` / Railway Variables):
```
ADMIN_USER=admin                          # login user ID
ADMIN_PASSWORD=choose-a-strong-password   # required – panel is disabled without it
ADMIN_PORT=3000                           # optional (Railway's PORT is used automatically)
ADMIN_HOST=127.0.0.1                      # 0.0.0.0 on Railway
ADMIN_TRUST_PROXY=false                   # true on Railway / behind nginx or Caddy
DATA_DIR=.                                # /data on Railway
TIMEZONE=Asia/Kolkata                     # used for daily auto-clear time and message timestamps
```

**Access tab** – alert chats, allowed users, and one-click approval of access requests. **Test** sends a test message to a chat.

**Accounts tab**
- **Blocked accounts**: no notifications (low balance or transaction failures), left out of balance checks, `/balance` and `/low`.
- **Skip inactive accounts**: whether accounts with `is_active = false` are checked.
- **All accounts**: every account from the last balance check, searchable and filterable. **Run balance check now** applies changes immediately.

**Chats tab**
- **Auto-clear** (on by default: continuously delete bot messages older than 24 hours). Choose *Continuously* (checked every 10 minutes) or *Once a day at a set time*, and how old a message must be (0–47 hours; 0 = everything, daily mode only).
- **Clear now** per chat, or **Clear all chats**. `/clear` in Telegram clears the current chat.
- Bots cannot read chat history, so the bot remembers the IDs of messages it sends and commands it handles, and deletes those. Telegram only allows deleting messages younger than 48 hours; messages sent before this feature existed can't be cleared.

**Functions tab**
A function is a set of APIs with its own **master key**. Each API uses the function's master key, its own separate key, or no key. Key header names are configurable (default `x-trexo-key` / `x-trexo-secret`). Keys are only ever shown masked; leave key fields blank when editing to keep them.

- **Balance check** (built-in) – its APIs feed low-balance alerts and `/bal`, `/balance`, `/low`. Add several and the accounts are combined.
- **Transaction failures** (built-in) – its APIs feed failure-streak alerts and `/failures`.
- **Custom functions** – click **+ New function**:
  - **Telegram command**, e.g. `trxn_wezbo` → `/trxn_wezbo` in Telegram. It appears in `/help` and the bot's command menu.
  - **APIs**: URL, GET/POST, optional query parameters (placeholders `{today}`, `{now}`, `{1h_ago}`, `{24h_ago}`), and which value to read: a number field (`data.count`), the number of items in a list, or the sum of a field across a list. Optionally pass the command text as a parameter (`/trxn_wezbo acme` → `?merchant=acme`).
  - **Alerts** (optional): check every N minutes and notify alert chats when the value is below/above/equal to a threshold – e.g. *below 100*. Sends one alert, reminders every N minutes (0 = never) and a “back to normal” message.
  - **Test** on an API shows the value it returns; **Check now** runs the alert check immediately.

Example – “notify when Wezbo transaction count goes below 100”:
1. **+ New function** → name *Wezbo transactions*, command `trxn_wezbo`, master key = your Wezbo key.
2. Turn on alerts: every 5 minutes, *below*, threshold `100`.
3. **+ Add API** → URL of the count API, key *Function's master key*, value *A number field* `data.count` (or *Number of items in a list*).
4. **Test** it, then try `/trxn_wezbo` in Telegram.

**Settings tab**
- **Telegram bot**: change the token. It's verified with Telegram first, then the bot reconnects without a restart.

**Logs tab** – everything the bot logs: alerts `[ALERT]`, commands `[CMD]`, denied access `[DENIED]`, admin actions `[ADMIN]`, chat clears `[CLEAR]`, errors. Secrets are masked as `***`.

**Security**
- Sessions last 12 hours. After 5 wrong passwords from the same IP, login is locked for 15 minutes.
- To reach the panel from outside the server, use HTTPS (Railway domain, or nginx/Caddy with `ADMIN_TRUST_PROXY=true`) or an SSH tunnel. Over plain HTTP the password is sent unencrypted.

## Run permanently
```
npm i -g pm2
pm2 start index.js --name monitor-bot
pm2 save && pm2 startup
```

## Adapting to your API
Edit `mapBalance()` and `mapTransaction()` in `index.js` so the field names match your API response. Use **Test** in the Settings tab to see which fields your API returns.

## Alerts
- 🚨 Customer has FAIL_THRESHOLD+ failed transactions in a row (repeats every FAIL_REPEAT_EVERY more failures)
- ✅ Recovery when that customer gets a successful transaction
- ⚠️ Account balance below BALANCE_THRESHOLD (reminder every BALANCE_REMIND_MINUTES)
- ✅ Balance restored
- 🔴 API not responding (per API)
