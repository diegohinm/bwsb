import { Router } from "express";

import { asyncHandler, fail, ok } from "../lib/response.js";
import { requireWorkerSecret } from "../middleware/requireWorkerSecret.js";
import { discussionHub } from "../realtime/discussionHub.js";
import {
  DISCUSSION_EVENT_TYPES,
  type DiscussionEvent,
  type DiscussionEventType,
} from "../realtime/discussionEvents.js";

/**
 * SERVICE-TO-SERVICE: the ingestion worker tells the API something happened, so
 * the API can push it to the browsers watching that ticker.
 *
 * The worker and the API are separate Render services with separate processes,
 * so the in-process hub cannot see the worker's writes. This is the bridge.
 *
 * WHAT THIS IS NOT: a source of truth. The worker has ALREADY persisted before
 * calling here. If this endpoint is down, the data is still in PostgreSQL and
 * the next REST snapshot picks it up — which is why the worker treats a failure
 * here as a log line, not an error.
 *
 * Guarded by a shared secret and NOT covered by the CORS allowlist: a browser
 * has no business calling it, and the middleware fails closed when the secret
 * is unset.
 */

export const internalRedditEventsRouter = Router();

/** Same shape the WebSocket already speaks — no second vocabulary. */
const SYMBOL = /^[A-Z][A-Z.\-]{0,9}$/;

function isEventType(value: unknown): value is DiscussionEventType {
  return (
    typeof value === "string" &&
    (DISCUSSION_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * POST /api/internal/reddit/events
 *
 * Body: { type, ticker, data }
 *   type   one of the six discussion event types
 *   ticker the symbol whose room should receive it
 *   data   the post/comment payload, or { id } for a deletion
 */
internalRedditEventsRouter.post(
  "/internal/reddit/events",
  requireWorkerSecret,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (!isEventType(body.type)) {
      return fail(res, "Unsupported event type", 400);
    }
    const ticker = String(body.ticker ?? "").trim().toUpperCase();
    if (!SYMBOL.test(ticker)) {
      return fail(res, "Invalid ticker symbol", 400);
    }

    const data = (body.data ?? {}) as Record<string, unknown>;
    const at = new Date().toISOString();
    let event: DiscussionEvent;

    if (body.type === "deletedPost" || body.type === "deletedComment") {
      const id = typeof data.id === "string" ? data.id : null;
      if (!id) return fail(res, "A deletion event requires data.id", 400);
      event = { type: body.type, ticker, at, id };
    } else if (body.type === "newPost" || body.type === "updatedPost") {
      // The ticker is taken from the envelope, not the payload — one authority
      // for which room this lands in.
      event = {
        type: body.type,
        ticker,
        at,
        post: { ...data, ticker } as DiscussionEvent extends { post: infer P } ? P : never,
      };
    } else {
      event = {
        type: body.type,
        ticker,
        at,
        comment: { ...data, ticker } as DiscussionEvent extends { comment: infer C } ? C : never,
      };
    }

    console.log(`[InternalRedditEvent] Received type=${body.type} ticker=${ticker}`);
    discussionHub.publish(event);
    console.log(
      `[InternalRedditEvent] Broadcast completed ticker=${ticker} ` +
        `subscribers=${discussionHub.subscriberCount(ticker)}`,
    );

    // The count tells the worker whether anyone was listening — useful in logs,
    // and never a reason for it to retry.
    return ok(res, { published: true, subscribers: discussionHub.subscriberCount(ticker) });
  }),
);
