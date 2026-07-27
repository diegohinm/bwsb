import { env } from "../config/env.js";
import { WORKER_MOVER_SESSIONS } from "../config/ingestion.js";
import { isMainModule, runJobAsScript, type JobMetadata } from "../lib/jobRunner.js";
import {
  readLatestMovers,
  saveMoversSnapshot,
  type MoverSnapshotInput,
} from "../repositories/marketSnapshots.repository.js";
import { getMarketMovers } from "../services/market-data/marketData.service.js";
import { currentSession } from "../services/market-data/marketData.util.js";
import type { MarketDataDisplayMode } from "../services/market-data/marketData.types.js";

/**
 * WORKER JOB — market movers.
 *
 * Snapshots the top movers for every session (regular / premarket / after_hours
 * / overnight) into `market_movers_snapshots`. Overnight comes from the
 * Databento overnight dataset when configured; the API then serves the newest
 * snapshot per session without touching Databento.
 *
 * Demo rows are written ONLY when demo is the configured mode. If a real
 * provider fails, the previous snapshot is left in place (the API keeps serving
 * it, labeled with its own timestamp) and the session is reported as failed.
 * One failing session never aborts the others.
 */

const MOVERS_PER_SESSION = 10;

function mockModeActive(): boolean {
  return env.MARKET_DATA_PROVIDER === "mock";
}

function safeDisplayMode(mode: MarketDataDisplayMode): MarketDataDisplayMode {
  return mode === "realtime" ? "delayed" : mode;
}

export async function refreshMarketMovers(): Promise<JobMetadata> {
  const snapshotAt = new Date().toISOString();
  const demoMode = mockModeActive();
  const written: Record<string, number> = {};
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const session of WORKER_MOVER_SESSIONS) {
    try {
      const resp = await getMarketMovers({ session, limit: MOVERS_PER_SESSION });

      // A degraded (mock) response from a real provider must not overwrite the
      // last good snapshot — unless demo IS the configured mode.
      if (resp.isMock && !demoMode) {
        skipped.push(session);
        continue;
      }

      const displayMode = safeDisplayMode(resp.displayMode);
      const rows: MoverSnapshotInput[] = resp.movers.map((m, i) => ({
        session,
        symbol: m.symbol,
        price: m.price,
        changePct: m.changePct,
        volume: m.volume ?? null,
        rank: i + 1,
        provider: resp.provider,
        source: resp.source,
        displayMode,
        delayMinutes: env.MARKET_DATA_DELAY_MINUTES,
        isMock: resp.isMock,
      }));

      written[session] = await saveMoversSnapshot(rows, snapshotAt);
    } catch (err) {
      failed.push(session);
      console.error(
        `[worker] refreshMarketMovers: session "${session}" failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (Object.keys(written).length === 0) {
    // Nothing new to store. That is only an ERROR when there is also nothing
    // stored from before — otherwise the API keeps serving the retained
    // snapshots and a closed market must not look like an outage.
    const retained = (
      await Promise.all(
        WORKER_MOVER_SESSIONS.map((s) => readLatestMovers(s, 1)),
      )
    ).filter(Boolean).length;

    const message =
      currentSession() === "closed"
        ? "Market closed; previous movers snapshots retained."
        : `No movers published (skipped=${skipped.join(",") || "none"}, failed=${failed.join(",") || "none"}); previous snapshots retained.`;

    if (retained === 0) {
      throw new Error(`${message} No previous movers snapshots exist for any session.`);
    }

    console.log(`[worker] refreshMarketMovers: ${message}`);
    return {
      status: currentSession() === "closed" ? "skipped_market_closed" : "success_without_change",
      message,
      provider: env.MARKET_DATA_PROVIDER,
      skippedDegraded: skipped,
      failed,
      sessionsRetained: retained,
    };
  }

  return {
    provider: env.MARKET_DATA_PROVIDER,
    snapshotAt,
    written,
    skippedDegraded: skipped,
    failed,
    delayMinutes: env.MARKET_DATA_DELAY_MINUTES,
  };
}

// Manual run: npm run movers:refresh
if (isMainModule(import.meta.url)) {
  void runJobAsScript("refreshMarketMovers", refreshMarketMovers);
}
