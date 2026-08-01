import { redditConfig } from "../../config/reddit.config.js";
import type { RedditWorkerStore } from "./redditWorkerStore.js";

/**
 * Round-robin over the configured subreddits.
 *
 * ONE subreddit per cycle, in `REDDIT_SUBREDDITS` order. With five communities
 * and a five-minute cycle that is 12 requests an hour in total and one visit
 * per community every 25 minutes — the arithmetic the pacing promise rests on.
 *
 * The index is PERSISTED, so restarting the worker resumes the rotation instead
 * of hammering the first subreddit in the list every deploy.
 *
 * The list itself is never copied, sorted or mutated here: `redditConfig` owns
 * it, this module only holds a position in it.
 */

export const ARCTIC_SHIFT_WORKER_NAME = "arctic-shift-posts";

export interface SchedulerSelection {
  subreddit: string;
  /** Position used, after clamping to the current list length. */
  index: number;
  /** What the next cycle will pick — logged as `nextSubreddit`. */
  nextSubreddit: string;
  nextIndex: number;
}

/**
 * The pure rotation step, kept separate so it can be reasoned about alone.
 *
 * `index` is taken modulo the list length: a persisted 4 with a list that has
 * shrunk to two entries would otherwise select `undefined` forever.
 */
export function selectSubreddit(
  subreddits: readonly string[],
  index: number,
): SchedulerSelection {
  if (subreddits.length === 0) {
    throw new Error("Cannot select a subreddit: the configured list is empty.");
  }

  const safeIndex = ((index % subreddits.length) + subreddits.length) % subreddits.length;
  const nextIndex = (safeIndex + 1) % subreddits.length;

  return {
    subreddit: subreddits[safeIndex] as string,
    index: safeIndex,
    nextSubreddit: subreddits[nextIndex] as string,
    nextIndex,
  };
}

/**
 * Stateful rotation backed by the worker-state table.
 *
 * `peek` reads without consuming, `advance` commits the move. They are separate
 * because a cycle must move on even when its request failed — but only once,
 * and only after the attempt actually happened.
 */
export class ArcticShiftScheduler {
  private readonly store: RedditWorkerStore;
  /** The row in `reddit_worker_state` this rotation lives in. */
  readonly workerName: string;
  private readonly subreddits: readonly string[];

  constructor(options: {
    store: RedditWorkerStore;
    workerName?: string;
    subreddits?: readonly string[];
  }) {
    this.store = options.store;
    this.workerName = options.workerName ?? ARCTIC_SHIFT_WORKER_NAME;
    // Read from the central config; the worker never carries its own list.
    this.subreddits = options.subreddits ?? redditConfig.subreddits;
  }

  get communities(): readonly string[] {
    return this.subreddits;
  }

  /** Which subreddit this cycle should process. Does not advance. */
  async peek(): Promise<SchedulerSelection> {
    const state = await this.store.loadState(this.workerName);
    const selection = selectSubreddit(this.subreddits, state.nextSubredditIndex);

    // The persisted index is out of range whenever REDDIT_SUBREDDITS shrinks.
    // Write the clamped value back so the stored state stops being nonsense.
    if (selection.index !== state.nextSubredditIndex) {
      console.warn(
        `[ArcticShiftScheduler] Stored index ${state.nextSubredditIndex} is out of range for ` +
          `${this.subreddits.length} subreddit(s); using ${selection.index}.`,
      );
      await this.store.setNextSubredditIndex(this.workerName, selection.index);
    }

    return selection;
  }

  /** Commit the move to the next subreddit. Called once per attempted cycle. */
  async advance(selection: SchedulerSelection): Promise<void> {
    await this.store.setNextSubredditIndex(this.workerName, selection.nextIndex);
  }
}
