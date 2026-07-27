import { env } from "./env.js";

/**
 * Process role guard — the hard boundary between the API and the ingestion
 * worker.
 *
 * ARCHITECTURE
 *   bwsb-api    (SERVICE_ROLE=api)    HTTP only. Reads DB/cache. MUST NOT call
 *                                     Mindcase or Databento on a user request.
 *   bwsb-worker (SERVICE_ROLE=worker) No HTTP. Calls the providers on a
 *                                     schedule and writes snapshots to the DB.
 *   all                               Single-process local development.
 *
 * This module makes the boundary ENFORCED rather than merely documented: the
 * upstream providers call `assertProviderCallsAllowed` before touching the
 * network, so an API-role process physically cannot reach a provider even if a
 * future code path forgets. The services already catch provider errors and fall
 * back to labeled demo data, so the guard degrades gracefully instead of 500ing.
 */

export const SERVICE_ROLE = env.SERVICE_ROLE;
export const isWorkerRole = SERVICE_ROLE === "worker";
export const isApiRole = SERVICE_ROLE === "api";
/** True when this process is allowed to talk to Mindcase/Databento. */
export const providerCallsAllowed = SERVICE_ROLE !== "api";

/** Raised when an API-role process attempts an upstream provider call. */
export class ProviderRoleError extends Error {
  constructor(provider: string) {
    super(
      `${provider} is worker-only: this process runs with SERVICE_ROLE=api and serves database snapshots. ` +
        `Run the ingestion worker (npm run worker) to refresh them.`,
    );
    this.name = "ProviderRoleError";
  }
}

/** Throw unless this process may call external data providers. */
export function assertProviderCallsAllowed(provider: string): void {
  if (!providerCallsAllowed) throw new ProviderRoleError(provider);
}
