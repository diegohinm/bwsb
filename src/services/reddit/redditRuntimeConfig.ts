import { env } from "../../config/env.js";
import { SERVICE_ROLE } from "../../config/serviceRole.js";
import {
  ACTIVE_REDDIT_COMMUNITIES,
  normalizeCommunity,
} from "../../config/redditCommunities.js";

/**
 * WHERE THE WORKER LEARNS WHICH COMMUNITIES IT MAY SPEND MONEY ON.
 *
 * The worker is a separate process and cannot read the API's environment, so it
 * asks. `REDDIT_ACTIVE_COMMUNITIES` exists in exactly one place — the backend —
 * and everything else derives from it. The worker deliberately has NO community
 * variable of its own: a second variable is a second truth, and the way those
 * two truths disagreed is what put r/options in front of a metered provider.
 *
 * FAIL-CLOSED IS THE WHOLE DESIGN. Every failure mode here resolves toward
 * spending LESS, never more:
 *
 *     config fetched            → ingest exactly those communities
 *     fetch fails, config fresh → keep using it (a 3-second blip must not stop
 *                                 ingestion)
 *     fetch fails, config stale → PAUSE. No Mindcase requests at all.
 *     never fetched             → PAUSE. Not "all supported", not a guessed
 *                                 default — nothing.
 *
 * THE RULE, stated once: a configuration failure must never widen Mindcase
 * scope. Falling back to the supported catalog would turn a backend outage into
 * eight metered subreddits, which is the most expensive possible response to
 * "we are not sure what to do".
 */

/**
 * How long a successfully fetched config stays usable after the backend stops
 * answering.
 *
 * Ten minutes is a deliberate middle. Zero would let a momentary network blip
 * halt ingestion — the backend restarting during a deploy is normal and should
 * not cost a gap in the data. Unbounded would mean a backend that has been down
 * for a day is still authorising spend against a config nobody can verify.
 */
export const CONFIG_GRACE_MS = 10 * 60_000;

/** How often the worker re-asks. Cheap, local, and not on any request path. */
export const CONFIG_REFRESH_MS = 5 * 60_000;

export type RedditRuntimeConfig = {
  activeCommunities: string[];
};

let config: RedditRuntimeConfig | null = null;
let lastSuccessAt: number | null = null;
let lastError: string | null = null;

/**
 * Single-process development: the worker and the API are the same process, so
 * the "authoritative" config is already in memory. Going out over HTTP to ask
 * ourselves would add a failure mode that exists only in development, and would
 * make `npm run dev` depend on the server being up before the worker.
 */
const isSingleProcess = SERVICE_ROLE === "all";

function adopt(communities: string[], source: string): void {
  config = { activeCommunities: communities };
  lastSuccessAt = Date.now();
  lastError = null;
  console.log(`[reddit-config] source=${source} active=${communities.join(",")}`);
}

/**
 * Validate what came back over the wire.
 *
 * A malformed payload is treated as a FAILURE, not as an empty list. An empty
 * `activeCommunities` would mean "ingest nothing", which is indistinguishable
 * here from "the endpoint is broken" — and quietly accepting it would let a
 * deploy that breaks the endpoint look like a deliberate pause.
 */
function readPayload(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object") return null;
  const reddit = (payload as { reddit?: unknown }).reddit;
  if (!reddit || typeof reddit !== "object") return null;

  const raw = (reddit as { activeCommunities?: unknown }).activeCommunities;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const communities = raw
    .filter((c): c is string => typeof c === "string")
    .map(normalizeCommunity)
    .filter(Boolean);

  return communities.length > 0 ? communities : null;
}

export async function refreshRedditRuntimeConfig(): Promise<boolean> {
  if (isSingleProcess) {
    adopt([...ACTIVE_REDDIT_COMMUNITIES], "local-env(single-process)");
    return true;
  }

  const base = env.API_INTERNAL_URL ?? env.BACKEND_URL;
  const secret = env.WORKER_INTERNAL_SECRET;

  if (!secret) {
    // No credential means no way to ask, and no way to ask means no authority
    // to spend. Explicitly NOT a reason to fall back to a local list.
    lastError = "WORKER_INTERNAL_SECRET is not configured";
    console.error(
      "[reddit-config] Unable to load active communities; ingestion paused. " +
        "WORKER_INTERNAL_SECRET is not set, so the worker cannot verify its scope.",
    );
    return false;
  }

  try {
    const response = await fetch(`${base}/internal/runtime-config`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) throw new Error(`runtime-config returned ${response.status}`);

    const communities = readPayload(await response.json());
    if (!communities) throw new Error("runtime-config payload had no usable activeCommunities");

    adopt(communities, "backend-runtime-config");
    return true;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    // NOTE what does NOT happen here: no assignment to `config`. A failed
    // refresh leaves the previous value alone, and the grace window decides
    // whether it is still trustworthy.
    if (withinGrace()) {
      console.warn(
        `[reddit-config] refresh failed (${lastError}); ` +
          `continuing on last-known-good active=${config?.activeCommunities.join(",")}`,
      );
    } else {
      console.error(
        `[reddit-config] Unable to load active communities; ingestion paused. (${lastError})`,
      );
    }
    return false;
  }
}

function withinGrace(): boolean {
  if (!config || lastSuccessAt === null) return false;
  return Date.now() - lastSuccessAt < CONFIG_GRACE_MS;
}

/**
 * May ingestion run at all?
 *
 * Checked before a cycle starts AND again inside the provider (see
 * assertCommunityIsActive), because one check is a policy and two checks are a
 * guarantee — the second one catches a caller that never consulted the first.
 */
export function canRunRedditIngestion(): boolean {
  return withinGrace();
}

/**
 * The communities ingestion is currently authorised for.
 *
 * Returns an EMPTY ARRAY when unauthorised rather than a default list. Callers
 * iterate it, so "no authority" naturally becomes "no requests" — there is no
 * value that could be returned here which would accidentally widen scope.
 */
export function activeCommunities(): string[] {
  return withinGrace() && config ? [...config.activeCommunities] : [];
}

export type RuntimeConfigStatus = {
  loaded: boolean;
  usable: boolean;
  activeCommunities: string[];
  ageSeconds: number | null;
  lastError: string | null;
};

export function runtimeConfigStatus(): RuntimeConfigStatus {
  return {
    loaded: config !== null,
    usable: withinGrace(),
    activeCommunities: config ? [...config.activeCommunities] : [],
    ageSeconds: lastSuccessAt === null ? null : Math.round((Date.now() - lastSuccessAt) / 1000),
    lastError,
  };
}

/** Raised by the provider guard. Named so a test can assert on the type. */
export class InactiveCommunityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InactiveCommunityError";
  }
}

/**
 * THE LAST LINE BEFORE MONEY IS SPENT.
 *
 * Called by the Mindcase client itself, not by its callers, so it holds even
 * when the bug is in the caller. That is the failure this is for: legacy code,
 * a stale import, a helper someone revives, a hardcoded string in a script —
 * any of them can ask for r/options, and none of them can get past this.
 *
 * It refuses on an unverified config too, not only on a wrong community. "We do
 * not know what is active" and "this is not active" have the same correct
 * answer: do not spend.
 */
export function assertCommunityIsActive(community: string): void {
  const normalized = normalizeCommunity(community);

  if (!withinGrace() || !config) {
    throw new InactiveCommunityError(
      `Mindcase blocked: Reddit runtime configuration unavailable, so the ` +
        `scope of "${normalized}" cannot be verified.`,
    );
  }

  if (!config.activeCommunities.includes(normalized)) {
    throw new InactiveCommunityError(
      `Mindcase blocked for inactive community: ${normalized}. ` +
        `Active: ${config.activeCommunities.join(", ")}.`,
    );
  }
}

/** Tests only. */
export function __resetRuntimeConfigForTests(): void {
  config = null;
  lastSuccessAt = null;
  lastError = null;
}

/** Tests only: install a config as if it had just been fetched. */
export function __setRuntimeConfigForTests(
  communities: string[],
  ageMs = 0,
): void {
  config = { activeCommunities: communities.map(normalizeCommunity) };
  lastSuccessAt = Date.now() - ageMs;
  lastError = null;
}
