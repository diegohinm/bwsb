import {
  arcticShiftWorkerConfig,
  assertRedditSubredditsUsable,
  describeRedditConfig,
  redditConfig,
} from "../../config/reddit.config.js";
import { getRedditDataConfig } from "../../config/redditDataConfig.js";
import { runJobOnce } from "../../lib/jobRunner.js";
import { ArcticShiftProvider } from "../../providers/reddit/ArcticShiftProvider.js";
import { persistPosts } from "../../services/redditIngestionService.js";
import { ArcticShiftRateGuard } from "./arcticShiftRateGuard.js";
import { ArcticShiftScheduler } from "./arcticShiftScheduler.js";
import {
  createArcticShiftWorker,
  type ArcticShiftWorkerHandle,
  type CycleMetrics,
} from "./arcticShiftWorker.js";
import { prismaRedditWorkerStore } from "./redditWorkerStore.js";

/**
 * Wire the Arctic Shift worker to its production collaborators.
 *
 * Everything the cycle depends on is injected here and nowhere else: the real
 * provider, the real persistence service, the Prisma-backed state store, and
 * `runJobOnce` so every cycle lands in `worker_runs` like every other job. The
 * cycle itself knows none of them, which is why the tests can drive it with
 * fakes and no database.
 */
/** Cycle outcomes that are not a failure of the upstream or of persistence. */
const HEALTHY_STATUSES = new Set(["SUCCESS", "EMPTY", "SKIPPED_COOLDOWN"]);

export function buildArcticShiftWorker(): ArcticShiftWorkerHandle {
  // Refuses to start on an empty or malformed REDDIT_SUBREDDITS, naming the
  // offending value. A rotation with nothing to rotate is a configuration bug,
  // not a quiet no-op.
  assertRedditSubredditsUsable(redditConfig);
  console.log(describeRedditConfig(redditConfig));

  const provider = new ArcticShiftProvider(getRedditDataConfig());
  const store = prismaRedditWorkerStore;
  const scheduler = new ArcticShiftScheduler({ store });
  const guard = new ArcticShiftRateGuard({
    workerName: scheduler.workerName,
    store,
    minIntervalMs: redditConfig.pollIntervalMs,
  });

  return createArcticShiftWorker({
    store,
    scheduler,
    guard,
    fetchPage: (input) => provider.fetchPostsPage(input),
    persist: (posts) => persistPosts(posts),
    config: redditConfig,
    workerConfig: arcticShiftWorkerConfig,
    // One `worker_runs` row per cycle, success or failure. `runJobOnce` never
    // throws, so a bad cycle can never break the loop.
    recordRun: async (name, run) => {
      let metrics: CycleMetrics | null = null;
      await runJobOnce(name, async () => {
        metrics = await run();

        // A failed upstream cycle is recorded as an ERROR row, not as a quiet
        // success: /api/ingestion/status is where an operator finds out that
        // Arctic Shift has been timing out for an hour. The throw is caught by
        // `runJobOnce` — the loop is unaffected and the metrics are already
        // captured above.
        if (!HEALTHY_STATUSES.has(metrics.requestStatus)) {
          throw new Error(
            `${metrics.requestStatus} for r/${metrics.subreddit}` +
              (metrics.httpStatus ? ` (HTTP ${metrics.httpStatus})` : ""),
          );
        }

        return {
          ...metrics,
          // Nothing new stored is healthy: the archive simply had nothing yet.
          ...(metrics.requestStatus === "SUCCESS"
            ? {}
            : { status: "success_without_change" }),
        };
      });
      return metrics;
    },
  });
}
