import {
  deduplicateComments,
  deduplicatePosts,
} from "./deduplicateRedditData.js";
import {
  AllRedditProvidersFailedError,
  sanitizeProviderError,
} from "./providerErrors.js";
import type { RedditDataProvider } from "./RedditDataProvider.js";
import type {
  NormalizedRedditComment,
  NormalizedRedditPost,
  RedditFetchCommentsInput,
  RedditFetchPostsInput,
  RedditProviderName,
} from "./types.js";

/**
 * `REDDIT_DATA_MODE=hybrid` — query every enabled provider and merge.
 *
 * WHY Promise.allSettled AND NOT Promise.all: `Promise.all` rejects on the
 * first failure and throws away the results of every other provider that
 * already succeeded. In hybrid mode that would mean one rate-limited upstream
 * costing us a complete, paid-for page from the other. `allSettled` waits for
 * everyone, logs whoever failed, and merges whatever came back.
 *
 * The merge is `deduplicateRedditData.ts`: records that both providers returned
 * collapse into one by Reddit id, with their `sources` combined, so the
 * database can never receive the same post twice.
 *
 * The only failure that propagates is "every provider failed" — that is a real
 * outage, and the worker must record it rather than write an empty run.
 */
export class HybridRedditProvider implements RedditDataProvider {
  /**
   * A composite still has to satisfy `RedditDataProvider`, whose `name` is a
   * concrete provider name. It reports the preferred provider, which is also
   * the one that wins `primarySource` on merged records.
   */
  readonly name: RedditProviderName;

  private readonly providers: RedditDataProvider[];
  private readonly preferredSource: RedditProviderName;
  private readonly deduplicate: boolean;

  constructor(
    providers: RedditDataProvider[],
    options: {
      preferredSource: RedditProviderName;
      /** REDDIT_DEDUPLICATE_RESULTS. Off is for debugging only. */
      deduplicate?: boolean;
    },
  ) {
    if (providers.length === 0) {
      throw new Error("HybridRedditProvider requires at least one provider.");
    }
    this.providers = providers;
    this.preferredSource = options.preferredSource;
    this.deduplicate = options.deduplicate ?? true;
    this.name = options.preferredSource;
  }

  /** Usable while at least one member is configured. */
  isAvailable(): boolean {
    return this.providers.some((provider) => provider.isAvailable());
  }

  async fetchPosts(input: RedditFetchPostsInput): Promise<NormalizedRedditPost[]> {
    const combined = await this.runAll("posts", (provider) =>
      provider.fetchPosts(input),
    );

    const merged = this.deduplicate
      ? deduplicatePosts(combined, { preferredSource: this.preferredSource })
      : combined;

    console.log(
      `[HybridRedditProvider] Combined ${merged.length} unique posts from ${combined.length} record(s)`,
    );
    return merged;
  }

  async fetchComments(
    input: RedditFetchCommentsInput,
  ): Promise<NormalizedRedditComment[]> {
    const combined = await this.runAll("comments", (provider) =>
      provider.fetchComments(input),
    );

    const merged = this.deduplicate
      ? deduplicateComments(combined, { preferredSource: this.preferredSource })
      : combined;

    console.log(
      `[HybridRedditProvider] Combined ${merged.length} unique comments from ${combined.length} record(s)`,
    );
    return merged;
  }

  /**
   * Run `call` against every provider concurrently, keep the successes, and
   * throw only when nothing succeeded.
   */
  private async runAll<T>(
    label: string,
    call: (provider: RedditDataProvider) => Promise<T[]>,
  ): Promise<T[]> {
    const settled = await Promise.allSettled(
      this.providers.map((provider) => call(provider)),
    );

    const combined: T[] = [];
    const failures: { provider: RedditProviderName; message: string }[] = [];

    settled.forEach((result, index) => {
      const provider = this.providers[index] as RedditDataProvider;
      if (result.status === "fulfilled") {
        combined.push(...result.value);
        console.log(
          `[HybridRedditProvider] ${provider.name} returned ${result.value.length} ${label}`,
        );
        return;
      }
      const message = sanitizeProviderError(result.reason);
      failures.push({ provider: provider.name, message });
      console.error(
        `[HybridRedditProvider] ${provider.name} failed for ${label}: ${message}`,
      );
    });

    if (failures.length === this.providers.length) {
      throw new AllRedditProvidersFailedError(failures);
    }

    return combined;
  }
}
