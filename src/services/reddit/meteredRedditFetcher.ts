import { mindcaseSocialDataProvider } from "../social/providers/mindcaseSocialData.provider.js";
import type { SocialPostItem } from "../social/socialData.types.js";

/**
 * THE FALLBACK LEG — the metered provider, reachable only through the router.
 *
 * WHY THIS THIN WRAPPER EXISTS. The ingestion jobs used to reach the metered
 * client through `getSocialDataProvider()`, the factory keyed on
 * `SOCIAL_DATA_PROVIDER`. That is how the free archive could be configured as
 * primary while every scheduled run still paid: the variable the operator set
 * and the variable the job read were different variables.
 *
 * So the factory is no longer in the ingestion path at all. This module names
 * the metered client directly and is imported by exactly one caller — the
 * router's fallback branch — which means "are we spending money" is answerable
 * by looking at who imports this file, rather than by tracing an env var
 * through a switch statement into a shared factory that also serves reads.
 *
 * NO POLICY LIVES HERE. It does not decide whether it should run, check a
 * budget, or count a failure; it fetches when called and throws when it cannot.
 * Every decision belongs to the router, so that "exactly one upstream per
 * cycle" is a property of one file instead of an agreement between several.
 *
 * The community guard still runs INSIDE the client itself, as it always did —
 * this wrapper deliberately does not re-implement it, because a guard that
 * lives at the call site is a guard a future call site can forget.
 */
export type MeteredRedditFetcher = {
  fetchPosts(params: { community: string; maxResults: number }): Promise<SocialPostItem[]>;
  fetchComments(params: {
    community: string;
    threadId: string;
    maxResults: number;
  }): Promise<SocialPostItem[]>;
};

export const meteredRedditFetcher: MeteredRedditFetcher = {
  async fetchPosts({ community, maxResults }) {
    const sweep = await mindcaseSocialDataProvider.fetchItems({
      subreddits: [community],
      maxResults,
    });
    // A partial failure is reported by the sweep rather than thrown. The rows
    // that did arrive are still worth storing, and the router treats the cycle
    // as successful — a community that answered is not an outage.
    return sweep.items;
  },

  async fetchComments({ community, threadId, maxResults }) {
    if (!threadId) {
      // The metered comments agent takes a thread URL and has no
      // community-wide mode, so a request without a thread cannot be built.
      // Explicit rather than silently returning nothing, which would look like
      // a quiet community and be counted as a healthy empty cycle.
      throw new Error(
        "The metered comments fallback requires a threadId; it has no community-wide mode.",
      );
    }
    return mindcaseSocialDataProvider.fetchThreadComments({
      subreddit: community,
      threadId,
      maxResults,
    });
  },
};
