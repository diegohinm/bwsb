import { refreshSocialCache } from "../services/social/index.js";

/**
 * Refresh the social provider cache: drop cached payloads, reset the circuit
 * breaker, and re-warm the tracked timeframes so the next public request is
 * served from a fresh cache. Manual/dev:
 *   npm run social:refresh
 *
 * A provider failure must NOT crash this job — the social service already falls
 * back to labeled demo data, so each warm resolves either way. Per-timeframe
 * provider / isMock / updatedAt is logged as evidence.
 */
async function main(): Promise<void> {
  try {
    const { warmed } = await refreshSocialCache();
    for (const w of warmed) {
      console.log(
        `[social:refresh] ${w.timeframe}: provider=${w.provider} isMock=${w.isMock} updatedAt=${w.updatedAt}`,
      );
    }
    const live = warmed.filter((w) => !w.isMock).length;
    console.log(
      `[social:refresh] done — warmed ${warmed.length} timeframe(s), ${live} live / ${warmed.length - live} demo.`,
    );
  } catch (err) {
    console.error(
      "[social:refresh] failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

void main();
