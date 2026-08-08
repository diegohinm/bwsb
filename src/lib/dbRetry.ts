/**
 * Bounded retry for TRANSIENT database failures.
 *
 * WHY THIS EXISTS, AND WHY IT IS SO NARROW
 *
 * `max clients reached in session mode` is temporary — the pooler is briefly
 * out of slots — but retrying it immediately is exactly what turns a brief
 * shortage into an outage: every waiting caller hammers the pooler at the same
 * moment and nobody gets in. So the delay grows, and it carries jitter, so two
 * processes that failed together do not come back together.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *   - It does not retry logic errors. A malformed query, a unique-constraint
 *     violation or a validation failure will fail identically three times; all
 *     retrying buys is three times the load and a slower error.
 *   - It never constructs a PrismaClient. A "reconnect" here would defeat the
 *     single-pool design this file exists to protect.
 *   - It is not meant to wrap individual queries. Use it at the boundary of a
 *     whole operation that is safe to repeat — a boot step, a job. Wrapping
 *     every call multiplies the connection pressure it is supposed to relieve.
 */

/** Prisma error codes worth a second attempt. */
const TRANSIENT_PRISMA_CODES = new Set([
  "P1000", // authentication failed (can be a pooler hiccup)
  "P1001", // can't reach database server
  "P1002", // server reached but timed out
  "P1008", // operation timed out
  "P1017", // server has closed the connection
  "P2024", // timed out fetching a connection from the pool
]);

/** Substrings that identify a connection-level failure in a message. */
const TRANSIENT_MESSAGE_HINTS = [
  "max clients reached",
  "emaxconnsession",
  "too many clients",
  "connection pool",
  "connection closed",
  "connection terminated",
  "can't reach database server",
  "server has closed the connection",
  "econnreset",
  "etimedout",
  "socket hang up",
];

/**
 * Is this failure worth waiting for, or is it going to fail the same way again?
 */
export function isTransientDbError(err: unknown): boolean {
  if (!err) return false;

  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_PRISMA_CODES.has(code)) return true;

  // A validation error has a code we do not recognize but is never transient;
  // treating it as such would just delay a deterministic failure.
  const name = (err as { name?: unknown }).name;
  if (name === "PrismaClientValidationError") return false;
  if (name === "PrismaClientKnownRequestError" && typeof code === "string") {
    // A known request error with a non-transient code (P2002 unique violation,
    // P2025 not found, …) will not improve by being repeated.
    return false;
  }

  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return TRANSIENT_MESSAGE_HINTS.some((hint) => message.includes(hint));
}

export type RetryOptions = {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Delay before attempt 2; doubles each time. */
  baseDelayMs?: number;
  /** Upper bound on a single delay. */
  maxDelayMs?: number;
  /** Prefix for log lines — the job or step name. */
  label: string;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to Math.random. */
  random?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `operation`, retrying only transient database failures.
 *
 * Delays are 1s, 2s, 4s … plus up to 250 ms of jitter, capped at `maxDelayMs`.
 * Logs which attempt failed, why, and when the next one is due — never the
 * connection string, which is why only `err.message` and `err.code` are read.
 */
export async function withDbRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 1_000,
    maxDelayMs = 8_000,
    label,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = Date.now();
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const durationMs = Date.now() - startedAt;
      const code = (err as { code?: unknown }).code;
      const detail = `${describe(err)}${typeof code === "string" ? ` (${code})` : ""}`;

      if (!isTransientDbError(err) || attempt === attempts) {
        console.error(
          `[db] ${label}: attempt ${attempt}/${attempts} failed after ${durationMs}ms — ${detail}` +
            (isTransientDbError(err) ? " — no attempts left" : " — not transient, not retrying"),
        );
        throw err;
      }

      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) +
        Math.round(random() * 250);
      console.warn(
        `[db] ${label}: attempt ${attempt}/${attempts} failed after ${durationMs}ms — ${detail} — retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

/** Message only — never the connection string, which can carry the password. */
function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0]!.slice(0, 200);
}
