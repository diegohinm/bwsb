# Arctic Shift ingestion worker

One HTTP request every five minutes. For the whole system. That is the entire
design constraint — everything in this directory exists to make it true.

Arctic Shift is a free community archive: no API key, no quota page, no
contract. The only thing keeping YOLOPulse from being a bad citizen is this
worker, so the budget is enforced in three independent places rather than
trusted to one.

## The arithmetic

```
REDDIT_SUBREDDITS = wallstreetbets,stocks,options,investing,pennystocks

00:00 → wallstreetbets     12 requests per hour, total
00:05 → stocks             each community visited every 25 minutes
00:10 → options            (5 subreddits × 5 minutes)
00:15 → investing
00:20 → pennystocks
00:25 → wallstreetbets
```

## Files

| File | Responsibility |
| --- | --- |
| `arcticShiftWorker.ts` | The cycle: pick, fetch once, dedupe, persist, advance. Plus the sequential loop. |
| `arcticShiftScheduler.ts` | Round-robin position, persisted so a restart resumes the rotation. |
| `arcticShiftRateGuard.ts` | ≥5 min between requests, ≤12/hour, `Retry-After`. |
| `redditWorkerStore.ts` | Durable state: rotation index, request log, cursors, lease. |
| `startArcticShiftWorker.ts` | Wires the real provider, `persistPosts` and `worker_runs`. |

## The rules, and where each is enforced

- **One request per cycle** — the cycle calls `fetchPage` exactly once. There is
  no loop, no pagination and no "just one more page".
- **No HTTP retries** — `ArcticShiftProvider.fetchPostsPage` sets
  `maxRetries: 0`. A retry is a request; three retries would be three requests
  in one cycle. `ARCTIC_SHIFT_MAX_RETRIES` counts *consecutive failed cycles*
  before a subreddit is cooled down, not attempts inside one.
- **≥5 minutes apart** — `ArcticShiftRateGuard`, measured from the START of the
  previous request and persisted in `reddit_worker_state.last_request_at`.
- **≤12 per hour** — a rolling log of ISO timestamps in the same row, so the
  ceiling survives a restart that an in-memory counter would forget.
- **No concurrency** — an in-process flag for this instance, and a
  compare-and-swap lease in the database for the case where Render runs two.
  (A lease, not `pg_advisory_lock`: the Supabase transaction pooler does not
  give a session a stable connection.)
- **The cursor never runs ahead of the data** — it advances only after the
  fetch, the normalization AND the write have all succeeded. A Prisma failure
  leaves the window intact so the next cycle re-reads it.

## Windows, overlap and full pages

Each subreddit has its own cursor. The next window opens
`REDDIT_CURSOR_OVERLAP_SECONDS` *before* the last stored post, because an
archive can index a post after one with a later timestamp. The duplicates that
overlap produces are intentional and collapse on `externalId`.

`sort=asc` walks the window oldest-first, so a truncated response ends at a
timestamp the cursor can safely resume from. When a response fills the page
(`hasMore`), the worker does **not** fetch again — that subreddit simply
continues from its cursor on its next turn, 25 minutes later, which keeps
catch-up inside the budget.

An empty response never moves the cursor forward to `now`. Doing so would
silently drop every post the archive had not indexed yet.

## What it does NOT govern

`POST /api/internal/reddit/scanner/test` — the admin Reddit Scanner — builds its
own provider and touches none of this: not the guard, not the rotation index,
not the cursors. An operator debugging an upstream must not be made to wait five
minutes, and their scan must not shift the worker's schedule. The page says so
in as many words.

## Running it

```bash
npm run dev:worker:reddit     # the paced loop (needs ARCTIC_SHIFT_ENABLED=true)
npm run dev:worker:reddit -- --once   # a single cycle, still rate-guarded
npm run reddit:ingest         # the legacy one-shot backfill across every subreddit
```

Inside the combined worker process (`npm run worker`), the loop starts itself
when `ARCTIC_SHIFT_ENABLED=true` and takes over from the generic
`runRedditIngestion` job — running both would multiply requests by the number of
communities.

Every cycle writes one `worker_runs` row with the full metrics: counts,
durations, window, `requestsLastHour`, `nextRequestAt`, and the indexing-latency
percentiles that decide whether Arctic Shift can be the primary provider.
