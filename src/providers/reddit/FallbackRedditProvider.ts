import {
  isFallbackEligibleError,
  sanitizeProviderError,
} from "./providerErrors.js";
import {
  toObservedError,
  type ProviderCallObserver,
} from "./providerObserver.js";
import type { RedditDataProvider } from "./RedditDataProvider.js";
import type {
  NormalizedRedditComment,
  NormalizedRedditPost,
  RedditFetchCommentsInput,
  RedditFetchPostsInput,
  RedditProviderName,
} from "./types.js";

/**
 * `REDDIT_DATA_MODE=fallback` — one provider does the work; the other is
 * insurance.
 *
 * CONTRACT
 *  1. Ask the primary provider.
 *  2. It returned records → return them. The secondary is NEVER called, so a
 *     healthy primary costs exactly one provider's worth of quota.
 *  3. It returned an empty array → ask the secondary, unless
 *     REDDIT_FALLBACK_ON_EMPTY=false. "No results" from an archive that is
 *     behind is exactly the case the second provider exists for.
 *  4. It threw a 429 / timeout / 5xx / network error / missing credentials →
 *     ask the secondary.
 *  5. It threw a 4xx because OUR request was wrong (bad subreddit, malformed
 *     filter) → rethrow. The same request would fail identically on the
 *     secondary, so falling back would just spend twice for the same bug.
 *
 * Every branch logs which provider actually answered.
 */
export class FallbackRedditProvider implements RedditDataProvider {
  /** Reports the primary — it is the provider this composite prefers. */
  readonly name: RedditProviderName;

  private readonly primary: RedditDataProvider;
  private readonly fallback: RedditDataProvider;
  private readonly fallbackOnEmpty: boolean;
  private readonly observer: ProviderCallObserver | undefined;

  constructor(
    primary: RedditDataProvider,
    fallback: RedditDataProvider,
    options: {
      fallbackOnEmpty?: boolean;
      /**
       * Per-provider outcome reporter for the internal scanner page. Purely
       * observational; production ingestion leaves it unset.
       */
      observer?: ProviderCallObserver;
    } = {},
  ) {
    this.primary = primary;
    this.fallback = fallback;
    this.fallbackOnEmpty = options.fallbackOnEmpty ?? true;
    this.observer = options.observer;
    this.name = primary.name;
  }

  /** Usable while either side can serve. */
  isAvailable(): boolean {
    return this.primary.isAvailable() || this.fallback.isAvailable();
  }

  fetchPosts(input: RedditFetchPostsInput): Promise<NormalizedRedditPost[]> {
    return this.withFallback("posts", (provider) => provider.fetchPosts(input));
  }

  fetchComments(
    input: RedditFetchCommentsInput,
  ): Promise<NormalizedRedditComment[]> {
    return this.withFallback("comments", (provider) =>
      provider.fetchComments(input),
    );
  }

  private async withFallback<T>(
    label: string,
    call: (provider: RedditDataProvider) => Promise<T[]>,
  ): Promise<T[]> {
    const startedAt = Date.now();
    try {
      const results = await this.observed(this.primary, startedAt, call);

      if (results.length > 0) {
        console.log(
          `[FallbackRedditProvider] Primary provider answered provider=${this.primary.name} ${label}=${results.length}`,
        );
        return results;
      }

      if (!this.fallbackOnEmpty) {
        console.log(
          `[FallbackRedditProvider] Primary returned no ${label} provider=${this.primary.name} (fallback on empty disabled)`,
        );
        return results;
      }

      console.warn(
        `[FallbackRedditProvider] Primary returned no ${label} provider=${this.primary.name}`,
      );
      return this.callFallback(label, call);
    } catch (error) {
      if (!isFallbackEligibleError(error)) {
        // A bad request is our bug, not an outage — surface it.
        console.error(
          `[FallbackRedditProvider] Primary provider rejected the request provider=${this.primary.name}: ${sanitizeProviderError(error)}`,
        );
        throw error;
      }

      console.error(
        `[FallbackRedditProvider] Primary provider failed provider=${this.primary.name}: ${sanitizeProviderError(error)}`,
      );
      return this.callFallback(label, call);
    }
  }

  private async callFallback<T>(
    label: string,
    call: (provider: RedditDataProvider) => Promise<T[]>,
  ): Promise<T[]> {
    console.log(
      `[FallbackRedditProvider] Using fallback provider=${this.fallback.name}`,
    );
    const results = await this.observed(this.fallback, Date.now(), call);
    console.log(
      `[FallbackRedditProvider] Fallback provider answered provider=${this.fallback.name} ${label}=${results.length}`,
    );
    return results;
  }

  /** Run one provider, reporting its outcome without altering it. */
  private async observed<T>(
    provider: RedditDataProvider,
    startedAt: number,
    call: (provider: RedditDataProvider) => Promise<T[]>,
  ): Promise<T[]> {
    try {
      const value = await call(provider);
      this.observer?.({
        provider: provider.name,
        success: true,
        receivedCount: value.length,
        durationMs: Date.now() - startedAt,
        error: null,
      });
      return value;
    } catch (error) {
      this.observer?.({
        provider: provider.name,
        success: false,
        receivedCount: 0,
        durationMs: Date.now() - startedAt,
        error: toObservedError(error),
      });
      throw error;
    }
  }
}
