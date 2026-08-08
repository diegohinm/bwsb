/**
 * Bounded-concurrency map.
 *
 * `Promise.all(items.map(...))` starts EVERY task at once. With one shared
 * Prisma client that does not open extra pooler sessions — the pool caps
 * that — but it does queue every task against a pool of three connections, so
 * a hundred-symbol competition turns into ninety-seven tasks waiting on a
 * timer, and the ones at the back time out with P2024 before they ever run.
 *
 * The fix is not "make it sequential": that trades a stampede for a job that
 * takes a hundred round trips end to end. A small window keeps the pool busy
 * without queueing behind itself.
 *
 * Default of 4 is deliberately just above the pool's 3: enough that a
 * connection is never idle waiting for the next task to be created, low enough
 * that the queue never grows.
 */

export const DEFAULT_DB_CONCURRENCY = 4;

/**
 * Run `task` over `items`, at most `limit` at a time, preserving input order.
 *
 * A task that throws rejects the whole call, exactly as `Promise.all` would —
 * callers that want per-item tolerance should catch inside their own task.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  task: (item: T, index: number) => Promise<R>,
  limit: number = DEFAULT_DB_CONCURRENCY,
): Promise<R[]> {
  if (items.length === 0) return [];

  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  // `width` workers pulling from a shared cursor: a slow item delays only its
  // own lane, not a whole batch, which a chunked implementation would.
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
