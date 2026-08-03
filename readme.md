# YOLOPulse

YOLOPulse is an external web application for organizing public retail investing discussions into aggregated, read-only market intelligence dashboards.

The project is currently in development/testing.

## Purpose

YOLOPulse helps users track public market discussion activity from investing-related online communities. The app focuses on aggregated analytics such as ticker mentions, public sentiment, structured bet activity, and retail attention trends.

The app is informational only and does not provide investment advice.

## Key Features

- Public market discussion dashboards
- Aggregated ticker mention tracking
- Public sentiment and stance indicators
- Structured bet activity tracking
- Retail attention trend detection
- Ticker pages
- Watchlists
- Alerts
- Virtual paper-trading portfolios
- Rankings and competitions

## Data providers

YOLOPulse never scrapes Reddit. Public discussion data is retrieved server-side
from swappable third-party providers, selected entirely through environment
variables:

| Domain | Variable | Options |
|---|---|---|
| Reddit posts/comments | `REDDIT_DATA_MODE` | `mindcase`, `arctic_shift`, `hybrid`, `fallback` |
| Subreddit Pulse | `SOCIAL_DATA_PROVIDER` | `mock`, `mindcase`, `brandwatch`, `reddit_official`, `off` |
| Market data | `MARKET_DATA_PROVIDER` | `mock`, `databento`, `polygon`, `alpaca`, `twelvedata` |

`hybrid` queries every enabled Reddit provider and merges the results,
de-duplicated by Reddit id; `fallback` uses a secondary provider only when the
primary is rate-limited, times out, errors or returns nothing. Switching
between them requires no code change — see
[`src/providers/reddit/README.md`](src/providers/reddit/README.md) and
`.env.example`.

Two processes run from this repo. **Only the worker** (`npm run worker`) calls
an upstream provider; the API (`npm start`) reads PostgreSQL and the frontend
reads the API. Provider API keys exist only in the worker's environment, and
the boundary is enforced in code, not just documented. If every provider is
unavailable the app continues serving the most recent stored data.

## Email (verification links + password resets)

Signup is link-first: the user submits an address, receives a one-time link, and
sets their password on that page. That only works if the backend can actually
send mail, so the endpoint reports a delivery failure instead of pretending the
message went out — `POST /auth/email/start` answers **502** when the mail server
refuses it, and **200** only after the message was accepted.

### Local development

Nothing to configure. With `DEV_EMAIL_MODE=true` (the default) the link is
printed to the backend console and kept in an in-memory dev outbox, so the whole
flow is testable without SMTP.

### Gmail / Google Workspace

Gmail refuses a normal account password over SMTP — it answers
`535-5.7.8 Username and Password not accepted` even when the password is
correct. You need an **App Password**:

1. Turn on **2-Step Verification** on the sending account:
   <https://myaccount.google.com/signinoptions/twosv>
   (App Passwords do not exist until 2FA is on.)
2. Create an App Password — choose *Mail* and name the device:
   <https://myaccount.google.com/apppasswords>
3. Google shows **16 characters in four groups**, e.g. `abcd efgh ijkl mnop`.
   Copy them into `SMTP_PASSWORD`. The spaces are presentation only; the backend
   strips them, but storing it without spaces is clearer.
4. **Restart the backend.** `.env` is read once at startup, so an edited value
   does nothing until the process restarts.

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=you@yourdomain.com
SMTP_PASSWORD=abcdefghijklmnop
SMTP_FROM=YOLOPulse <you@yourdomain.com>
DEV_EMAIL_MODE=false
```

Notes:

- **Port and TLS go together.** 465 is implicit TLS (`SMTP_SECURE=true`); 587 is
  STARTTLS (`SMTP_SECURE=false`). Leave `SMTP_SECURE` blank and the correct
  value is derived from the port. 465 with `secure=false` will hang.
- **`SMTP_FROM` must be the authenticated account** or an alias Google allows it
  to send as. An unrelated address is rewritten or rejected.
- `SMTP_PASS` and `EMAIL_FROM` are still accepted as older names for
  `SMTP_PASSWORD` and `SMTP_FROM`.

### Checking the configuration

The backend verifies SMTP once at startup and prints the result. It never prints
the password — only whether one is set and how long it is, which is exactly what
distinguishes a correct 16-character app password from a pasted 19-character one:

```
[email] SMTP ready { host: 'smtp.gmail.com', port: 465, secure: true,
                     user: 'you@yourdomain.com', passwordConfigured: true,
                     passwordLength: 16, consoleMode: false }
```

A failure is logged as `[email] SMTP verification FAILED` with the SMTP `code`,
`responseCode` and `command`. It never blocks startup: a broken mail
configuration must not take the whole API down.

## Reddit Integration

YOLOPulse is an external web app, not a Reddit-hosted Devvit app.

The app intends to use Reddit OAuth only for optional user sign-in.

Requested OAuth scope:

```text
identity