# Database schema & migrations

`prisma/schema.prisma` is the **single source of truth** for the bwsb database:
models, relations, indexes and every column name. `prisma/migrations/` is the
only thing that changes the database. The old hand-rolled
`src/scripts/setupDatabase.ts` / `dropDatabase.ts` are gone.

## Conventions

Models are PascalCase and fields camelCase; `@@map` / `@map` point them at the
unchanged snake_case database names. **The database is never renamed** — only the
TypeScript-facing names are idiomatic.

Repositories map rows back to their database column names before returning them,
because those key names are the API contract the frontend reads (see
`src/lib/rows.ts`).

## Everyday workflow

```bash
npm run prisma:status         # is the database up to date?
npm run prisma:migrate:dev    # after editing schema.prisma: create + apply a migration
npm run prisma:migrate:deploy # apply pending migrations (prod)
npm run prisma:generate       # regenerate the client only
npm run db:setup              # alias of prisma:migrate:deploy
npm run db:seed               # prisma db seed → prisma/seed.ts
npm run db:reset              # DESTRUCTIVE, dev only: drop, re-migrate, re-seed
```

Order matters: **migrate before seed**. The seed writes rows, it does not create
tables.

## Seeding

`prisma/seed.ts` is the one canonical seed (`package.json#prisma.seed`). It has
three tiers:

| Tier | What | When |
|---|---|---|
| Reference data | the 27-symbol ticker catalog | always |
| Default config | the default paper-trading season | always |
| Demo data | fake users, bets, portfolios, social posts, mock quotes | only `SEED_DEMO_DATA=true` |

`SEED_DEMO_DATA` defaults to **false**, and demo content is refused outright
when `NODE_ENV=production` — a stray `true` in a production environment cannot
publish fake bets. Set it in `.env` for local development.

Every write is an upsert on a stable key, or a delete scoped to rows the seed
owns followed by an insert. Running it twice changes no row counts. It never
truncates, never touches real users, sessions, tokens, `worker_runs` or provider
snapshots, and skips any `market_quotes_latest` row that already holds real
(`isMock = false`) provider data.

Demo rows are marked: `provider='mock'`, `source='seed'`, `isMock=true` where the
column exists, and `{"seeded": true, "seedKey": "yolopulse-dev-seed"}` in JSON
metadata columns. Demo cleanup only ever matches that marker.

One caveat: the time-bucketed tables (`ticker_metrics_5m`,
`ticker_trend_classifications`, `signal_scores`, …) key on a timestamp bucket, so
seeding again in a *later* hour adds that hour's bucket rather than replacing the
previous one. That is the intended shape of those tables, not a duplicate.

`npm run db:reset` wipes **every** table, auth tables included, and re-runs the
seed. The previous `db:drop` script deliberately spared `app_users` and friends;
Prisma Migrate has no such carve-out. Never point it at production.

Never run `prisma db push`: it changes the database without recording a
migration, so the two immediately disagree.

## The 0_init baseline

`migrations/0_init/migration.sql` describes the schema as it already existed when
the project moved onto Prisma Migrate. It was **never executed** against the
production database — it was recorded as already applied with:

```bash
npx prisma migrate resolve --applied 0_init
```

It *is* executed in full on a brand-new database (CI, a local copy, a restore),
so it has to reproduce the schema exactly. That includes the PostgreSQL
behaviour Prisma cannot express in `schema.prisma`, appended by hand at the
bottom of the file:

- `CREATE EXTENSION pgcrypto` (every `gen_random_uuid()` default depends on it)
- 18 `CHECK` constraints (Prisma has no check-constraint support)
- the partial unique index `app_users_google_sub_uniq … WHERE google_sub IS NOT NULL`
- `ENABLE ROW LEVEL SECURITY` on every table

**When you add a migration, keep this in mind:** Prisma generates the DDL for
tables, columns and ordinary indexes, but you must hand-add any new check
constraint, partial index, or `ENABLE ROW LEVEL SECURITY` for a new table. RLS
matters: bwsb connects as the service role and bypasses it, but with RLS on and
no permissive policies an anon/authenticated Supabase client reads zero rows.
A table created without it would be world-readable.

## Raw SQL

There is none in application code. The only direct `pg` usage left is
`src/lib/sessionStore.ts`, because `connect-pg-simple` requires a `pg.Pool` and
issues its own SQL against the `session` table.
