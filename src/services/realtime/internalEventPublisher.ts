import { env } from "../../config/env.js";
import type { DiscussionEventType } from "../../realtime/discussionEvents.js";

/**
 * WORKER SIDE of the realtime bridge: tell the API something was written.
 *
 * THE DATABASE IS THE SOURCE OF TRUTH. This is called AFTER a successful
 * persist, and every failure here is swallowed on purpose:
 *
 *   - the row is already stored, so nothing is lost;
 *   - the API's REST snapshot will serve it on the next read;
 *   - a browser that reconnects re-fetches that snapshot anyway.
 *
 * So a broadcast that does not land costs a few seconds of latency for whoever
 * happens to be watching — never a row, and never a failed ingestion cycle. It
 * must therefore never throw into the worker loop.
 *
 * Unconfigured (no API_INTERNAL_URL or no WORKER_INTERNAL_SECRET) is a valid
 * deployment: the worker simply persists and stays quiet.
 */

/** Short by design — the worker must not stall behind a slow or dead API. */
const TIMEOUT_MS = 5_000;

export type InternalEventInput = {
  type: DiscussionEventType;
  ticker: string;
  data: Record<string, unknown>;
};

let warnedUnconfigured = false;

export function isEventPublishingConfigured(): boolean {
  return Boolean(env.API_INTERNAL_URL && env.WORKER_INTERNAL_SECRET);
}

/**
 * Publish one event. Resolves `true` when the API accepted it, `false` in every
 * other case. NEVER throws and never rethrows.
 */
export async function publishInternalEvent(input: InternalEventInput): Promise<boolean> {
  if (!isEventPublishingConfigured()) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        "[RedditWorker] Realtime publishing is off (API_INTERNAL_URL / WORKER_INTERNAL_SECRET unset). " +
          "Data is still persisted; clients pick it up on their next REST snapshot.",
      );
    }
    return false;
  }

  const url = `${env.API_INTERNAL_URL!.replace(/\/+$/, "")}/api/internal/reddit/events`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The secret goes in the header and NOWHERE else — not in a log line,
        // not in an error message, not in a URL.
        Authorization: `Bearer ${env.WORKER_INTERNAL_SECRET}`,
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(
        `[RedditWorker] Event publish rejected status=${response.status} ` +
          `type=${input.type} ticker=${input.ticker} (data is stored; continuing)`,
      );
      return false;
    }

    console.log(`[RedditWorker] Event published ticker=${input.ticker} type=${input.type}`);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.name : "unknown";
    console.warn(
      `[RedditWorker] Event publish failed (${reason}) type=${input.type} ` +
        `ticker=${input.ticker} — data is stored; continuing.`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Publish a batch without letting one failure affect the others or the caller.
 * Returns how many landed, purely for the cycle's log line.
 */
export async function publishInternalEvents(
  events: InternalEventInput[],
): Promise<number> {
  if (events.length === 0 || !isEventPublishingConfigured()) return 0;
  const results = await Promise.all(events.map((e) => publishInternalEvent(e)));
  return results.filter(Boolean).length;
}
