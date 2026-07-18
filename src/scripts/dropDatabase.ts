import 'dotenv/config'
import pg from 'pg'

const { Client } = pg

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  console.error('Missing DATABASE_URL in .env')
  process.exit(1)
}

if (
  !databaseUrl.startsWith('postgresql://') &&
  !databaseUrl.startsWith('postgres://')
) {
  console.error('Invalid DATABASE_URL. It must start with postgresql:// or postgres://')
  process.exit(1)
}

const dropSql = `
drop table if exists public.ticker_alerts cascade;
drop table if exists public.ticker_metrics_5m cascade;
drop table if exists public.ticker_mentions cascade;
drop table if exists public.reddit_posts cascade;
drop table if exists public.tickers cascade;
`

async function main() {
  const client = new Client({
    connectionString: databaseUrl,
  })

  try {
    console.log('Connecting to database...')
    await client.connect()

    console.log('Dropping StonkTerminal / wsb project tables...')
    await client.query('begin')
    await client.query(dropSql)
    await client.query('commit')

    console.log('Database tables dropped successfully.')
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    console.error('Failed to drop database tables:', error)
    process.exit(1)
  } finally {
    await client.end()
  }
}

main()