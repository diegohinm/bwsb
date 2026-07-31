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

## Reddit Integration

YOLOPulse is an external web app, not a Reddit-hosted Devvit app.

The app intends to use Reddit OAuth only for optional user sign-in.

Requested OAuth scope:

```text
identity