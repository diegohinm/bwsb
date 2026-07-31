# Reddit data providers

Where Reddit content comes from, and how to change it without touching code.

```
.env  →  config/redditDataConfig.ts  →  RedditProviderFactory  →  RedditDataProvider
                                                                        │
                          services/redditIngestionService.ts  ──────────┘
                                                                        │
                          repositories/redditContent.repository.ts  ────┘
                                                                        │
                                          reddit_posts / reddit_comments
```

## The one rule

**Only the worker calls an upstream.** The API reads PostgreSQL, the frontend
reads the API. `config/serviceRole.ts` enforces this: a process running with
`SERVICE_ROLE=api` cannot reach Mindcase or Arctic Shift even if a future code
path tries. When both providers are down, ingestion stalls and the dashboard
keeps serving the last stored data — nothing breaks.

## Modes

Set `REDDIT_DATA_MODE`:

| Mode | Behaviour |
|---|---|
| `mindcase` | Mindcase only. Arctic Shift is never constructed. |
| `arctic_shift` | Arctic Shift only. Mindcase is never constructed. |
| `hybrid` | Both in parallel (`Promise.allSettled`), merged and de-duplicated by Reddit id. Fails only if *every* provider fails. |
| `fallback` | `REDDIT_PRIMARY_PROVIDER` first; `REDDIT_FALLBACK_PROVIDER` only on 429 / timeout / 5xx / network error / empty result. **Not** on a 4xx — a bad request would fail identically elsewhere. |

`REDDIT_ENABLE_MINDCASE` / `REDDIT_ENABLE_ARCTIC_SHIFT` are master switches. A
disabled provider is never instantiated. Contradictory combinations
(`mode=mindcase` + `REDDIT_ENABLE_MINDCASE=false`, or a fallback pair that is
the same provider twice) are refused with an explicit error.

See `.env.example` for the full annotated variable list.

## Files

| File | Responsibility |
|---|---|
| `types.ts` | `NormalizedRedditPost` / `NormalizedRedditComment` — the shapes everything else speaks. |
| `RedditDataProvider.ts` | The interface every provider implements. |
| `MindcaseProvider.ts` | Mindcase async-job API: create job → poll `/jobs/{id}/results`. |
| `ArcticShiftProvider.ts` | Arctic Shift archive search, paginated and rate-paced. |
| `HybridRedditProvider.ts` | Query all, merge, tolerate partial failure. |
| `FallbackRedditProvider.ts` | Primary, with the secondary as insurance. |
| `RedditProviderFactory.ts` | Config → one provider. Memoized singleton. |
| `normalizeRedditData.ts` | Upstream payload → canonical record. |
| `deduplicateRedditData.ts` | Collapse the same record from two providers into one. |
| `providerErrors.ts` | Typed errors + `isFallbackEligibleError`. |
| `httpClient.ts` | Timeouts, `Retry-After`-aware 429 handling, backoff, URL redaction. |
| `providerHealth.ts` | Per-provider health for the internal status endpoint. |

## The id convention

Everything depends on this. Both providers normalize to the **prefix-free**
Reddit id:

```
t3_abc123  →  abc123      (post)
t1_xyz789  →  xyz789      (comment)
```

That id is the primary key of `reddit_posts` / `reddit_comments`, so ingestion
is an upsert and the same post from two providers can only ever produce one
row. `sources` accumulates every provider that has returned it; `source` names
the one treated as authoritative.

## Merge rules

When both providers return the same record:

1. `sources` = union, preferred provider first.
2. `source` = the configured primary provider, when it contributed.
3. Content (title, body, permalink, …) — the **most complete** value wins. A
   provider returning a truncated preview can never erase a full DD post.
4. Volatile metrics (score, comment count) — from the **most recently fetched**
   record. Scores go down as well as up, so "newest" is correct and "highest"
   is not.
5. `createdAt` — the earliest observed value. A post is not created twice.

## Adding a provider

1. Add its name to `RedditProviderName` in `types.ts`.
2. Write the class implementing `RedditDataProvider`; keep every upstream-shaped
   field inside it, plus a `normalize<Provider><Post|Comment>` in
   `normalizeRedditData.ts`.
3. Register it in `RedditProviderFactory.instantiate` and in
   `redditDataConfig.ts` (enable flag + settings).
4. Add mode tests to `__tests__/providerModes.test.ts`.

No service, route or repository should need editing.

## Operating it

```bash
npm run reddit:ingest        # one manual run
npm test                     # provider unit tests
```

Health, per provider, admin-only:

```bash
curl -H "x-admin-secret: $ADMIN_SECRET" \
  http://localhost:4000/api/internal/reddit/providers/status
```

Health counters are **per process**, and the worker is the process that calls
providers — query it there for live call history.

## Credentials

`MINDCASE_API_KEY` is read from configuration, sent only in the `Authorization`
header, and never logged. `httpClient.redactUrl` scrubs credential-shaped query
parameters and `sanitizeProviderError` strips bearer tokens from any message
that reaches a log line, the status endpoint or `worker_runs`. There is a test
for this (`__tests__/providerModes.test.ts` → "credential safety").
