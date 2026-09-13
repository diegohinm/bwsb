import { createHash } from "node:crypto";

import { getRedditDataConfig } from "../../../config/redditDataConfig.js";
import { assertCommunityIsActive } from "../../reddit/redditRuntimeConfig.js";
import { ArcticShiftProvider } from "../../../providers/reddit/ArcticShiftProvider.js";
import { canonicalRedditUrl, normalizeFlair } from "../redditPermalink.js";
import { classifySocialItem } from "../socialClassifier.service.js";
import { extractTickersFrom } from "../tickerExtractor.service.js";
import type {
  NormalizedRedditComment,
  NormalizedRedditPost,
} from "../../../providers/reddit/types.js";
import type { SocialPostItem } from "../socialData.types.js";

/**
 * ARCTIC SHIFT → `SocialPostItem`.
 *
 * THE SEAM THIS FILE EXISTS TO CLOSE. The product reads `social_posts` and
 * `social_comments`; everything visible — Discussion, the pulse, Top/Hot
 * tickers, the strip, Arena — is derived from those two tables, and the only
 * writer is `saveSocialItems`, which speaks `SocialPostItem`. The Arctic Shift
 * provider speaks `NormalizedRedditPost`/`NormalizedRedditComment` and its
 * existing worker wrote `reddit_posts`, a table no product surface reads. So
 * Arctic Shift data was, in the most literal sense, going nowhere.
 *
 * This adapter is the whole migration in one file: it makes the free archive
 * produce exactly the shape the paid provider produced, so the incremental
 * sync, the persistence layer, the ticker pipeline and every read path keep
 * working untouched.
 *
 * WHAT IS REUSED RATHER THAN REIMPLEMENTED. Classification
 * (`classifySocialItem`), ticker extraction (`extractTickersFrom`), permalink
 * canonicalization and flair normalization are the SAME functions the metered
 * provider calls. A second implementation would drift, and the drift would show
 * up as a sentiment or a ticker count that changed when the provider changed —
 * which would make the migration unmeasurable.
 *
 * WHAT IS DELIBERATELY NOT HERE. No fallback logic, no failure counting, no
 * provider choice. This file fetches when asked and throws when it cannot; the
 * router owns every decision about WHETHER to call it. Keeping policy out of
 * the adapter is what makes "exactly one provider per cycle" checkable.
 */

/**
 * Anonymize an author.
 *
 * BYTE-IDENTICAL to the metered provider's function and to
 * `redditContent.repository.hashAuthor`, deliberately: the same person must
 * hash to the same value across providers, or the migration would silently fork
 * every author's history into a before and an after.
 */
function hashAuthor(author: string | null | undefined): string | undefined {
  if (!author) return undefined;
  return `anon_${createHash("sha256").update(author).digest("hex").slice(0, 12)}`;
}

/** Read a string off the preserved raw record without trusting its shape. */
function rawStr(raw: unknown, key: string): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function rawNum(raw: unknown, key: string): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = (raw as Record<string, unknown>)[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Does this record look like it carries an image or video?
 *
 * Only feeds the screenshot heuristic in the classifier, so a miss costs a
 * slightly worse guess and never a dropped row.
 */
function hasMediaFrom(raw: unknown, url: string | null): boolean {
  if (rawStr(raw, "post_hint")) return true;
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    if (record.is_video === true) return true;
    if (record.preview && typeof record.preview === "object") return true;
  }
  return url !== null && /(i\.redd\.it|v\.redd\.it|imgur\.com)/i.test(url);
}

/**
 * ARCHIVE LAG for one page, in seconds.
 *
 * `retrieved_on - created_utc` per record — how long the archive took to index
 * content that already existed. The MEDIAN is used rather than the max so a
 * single re-indexed straggler cannot trip the fallback, and rather than the
 * mean so the same straggler cannot drag the average either.
 *
 * WHY NOT "age of the newest item". That is the obvious measure and it is
 * wrong: on a quiet community at 3am the newest item is legitimately an hour
 * old, and a policy built on it would declare a perfectly healthy archive
 * broken and start paying a metered provider for the privilege. Lag must be
 * measured against what the archive itself claims, never against the clock.
 *
 * Null when no record carried `retrieved_on` — unmeasurable is not zero, and a
 * caller must not read "no evidence of lag" as "no lag".
 */
export function archiveLagSeconds(records: readonly unknown[]): number | null {
  const samples: number[] = [];
  for (const raw of records) {
    const retrieved = rawNum(raw, "retrieved_on");
    const created = rawNum(raw, "created_utc");
    if (retrieved === undefined || created === undefined) continue;
    const lag = retrieved - created;
    // A negative lag means the archive claims it indexed the item before it was
    // written. That is a clock artifact, not a measurement.
    if (lag >= 0) samples.push(lag);
  }
  if (samples.length === 0) return null;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? null;
}

/**
 * POST → `SocialPostItem`.
 *
 * Returns null for a record with neither a title nor a body — parity with the
 * metered provider, so the two sources agree on what counts as a row.
 */
export function postToSocialItem(
  post: NormalizedRedditPost,
  /**
   * The NORMALIZED community id, which is what every consumer queries by.
   *
   * Not `post.subreddit`: the archive echoes Reddit's own display casing
   * (`ValueInvesting`), while the active-community list is lowercased at the
   * source. Storing the archive's spelling would make every ingestion-side
   * lookup — the cold-start high-water mark, comment thread selection, the
   * pulse membership filter — miss its own rows under case-sensitive equality,
   * silently. The metered provider it replaces lowercased for exactly this
   * reason, so this keeps the two sources writing the same value.
   */
  community?: string,
): SocialPostItem | null {
  const title = post.title.trim().length > 0 ? post.title : undefined;
  const text = post.body ?? undefined;
  if (!title && !text) return null;

  // `permalink` is the thread's OWN address; `url` is where the post points OUT
  // to — an article, or an image on Reddit's own media hosts. Conflating them is
  // how an "Open on Reddit" action ends up on a third-party page.
  //
  // The test is "is it the same place as the permalink", NOT "is it a Reddit
  // host": `i.redd.it` and `v.redd.it` ARE Reddit hosts and canonicalize
  // happily, but an image on one of them is still the thing the post links to,
  // not the thread. Checking the host would classify every image post as having
  // no outbound link at all.
  const url = canonicalRedditUrl(post.permalink) ?? undefined;
  const canonicalTarget = post.url ? canonicalRedditUrl(post.url) : null;
  const outbound =
    post.url && canonicalTarget !== url ? (canonicalTarget ?? post.url) : undefined;

  const flair = normalizeFlair(rawStr(post.raw, "link_flair_text")) ?? undefined;
  const cls = classifySocialItem({
    ...(title ? { title } : {}),
    ...(text ? { text } : {}),
    ...(flair ? { flair } : {}),
    ...(url ? { url } : {}),
    isComment: false,
    hasMedia: hasMediaFrom(post.raw, post.url),
  });

  return {
    // BARE reddit id. This is the dedup key and the upsert key.
    id: post.externalId,
    provider: "arctic_shift",
    source: "arctic_shift",
    subreddit: community ?? post.subreddit,
    type: cls.contentType,
    ...(title ? { title } : {}),
    ...(text ? { text } : {}),
    ...(url ? { url } : {}),
    ...(outbound ? { externalLink: outbound } : {}),
    ...(hashAuthor(post.author) ? { authorHash: hashAuthor(post.author) } : {}),
    score: post.score,
    numComments: post.commentCount,
    // MUST be a parseable ISO string: the ticker-activity writer silently skips
    // any item whose date does not parse, so an epoch number here would cost
    // every mention with no error anywhere.
    createdAt: post.createdAt.toISOString(),
    tickers: extractTickersFrom(title, text),
    sentiment: cls.sentiment,
    stance: cls.stance,
    confidence: cls.confidence,
    isScreenshot: cls.isScreenshot,
    ...(flair ? { flair } : {}),
    // LOAD-BEARING. The comment stream selects its threads with
    // `redditId: { not: null }`; a post stored without a fullname is invisible
    // to it, and comment ingestion would stop with nothing logged.
    ...(post.fullname ? { redditId: post.fullname } : {}),
  };
}

/**
 * COMMENT → `SocialPostItem`.
 *
 * `type` is forced to "comment": that field is what routes the row to
 * `social_comments` rather than `social_posts`, so it is never inferred.
 */
export function commentToSocialItem(
  comment: NormalizedRedditComment,
  threadId?: string,
  /** The normalized community id — see the note on postToSocialItem. */
  community?: string,
): SocialPostItem | null {
  const text = comment.body ?? undefined;
  // A comment has no title, so the post rule ("neither title nor body") would
  // let empty bodies through.
  if (!text) return null;

  const url = canonicalRedditUrl(comment.permalink) ?? undefined;
  const cls = classifySocialItem({ text, isComment: true, hasMedia: false });

  // The BARE parent id. `inheritThreadTypes` compares this against the parent
  // post's reddit_id with its prefix stripped, so a `t3_` here would match
  // nothing and the Daily Discussion tab would stay empty.
  const parent = threadId ?? (comment.postId.length > 0 ? comment.postId : undefined);

  return {
    id: comment.externalId,
    provider: "arctic_shift",
    source: "arctic_shift",
    subreddit: community ?? comment.subreddit,
    type: "comment",
    text,
    ...(url ? { url } : {}),
    ...(hashAuthor(comment.author) ? { authorHash: hashAuthor(comment.author) } : {}),
    score: comment.score,
    createdAt: comment.createdAt.toISOString(),
    tickers: extractTickersFrom(undefined, text),
    sentiment: cls.sentiment,
    stance: cls.stance,
    confidence: cls.confidence,
    isScreenshot: cls.isScreenshot,
    ...(parent ? { postExternalId: parent } : {}),
    ...(comment.fullname ? { redditId: comment.fullname } : {}),
    // Flair is deliberately absent: a comment inherits its thread's
    // classification after persistence rather than carrying its own.
  };
}

export type ArcticFetchResult = {
  items: SocialPostItem[];
  /** Records the archive returned, before normalization dropped any. */
  receivedCount: number;
  /** The page was full — more is waiting just past it. */
  hasMore: boolean;
  /** Median archive lag across the page, or null when unmeasurable. */
  lagSeconds: number | null;
  /** Newest `created_utc` SEEN, including rows already stored. */
  newestSeenAt: Date | null;
  newestSeenId: string | null;
};

function newestOf(
  items: { createdAt: Date; externalId: string }[],
): { at: Date | null; id: string | null } {
  let at: Date | null = null;
  let id: string | null = null;
  for (const item of items) {
    if (Number.isNaN(item.createdAt.getTime())) continue;
    if (!at || item.createdAt > at) {
      at = item.createdAt;
      id = item.externalId;
    }
  }
  return { at, id };
}

/**
 * The free, incremental Reddit source.
 *
 * Deliberately NOT a `SocialDataProvider`: that interface is the READ contract
 * (pulse, ticker feed, status) and this is ingestion only. Implementing it
 * would put this class behind `getSocialDataProvider()`, which is precisely the
 * factory the migration exists to take out of the ingestion path.
 */
export class ArcticShiftSocialSource {
  readonly name = "arctic_shift" as const;

  private readonly provider: ArcticShiftProvider;

  constructor(provider?: ArcticShiftProvider) {
    this.provider = provider ?? new ArcticShiftProvider(getRedditDataConfig());
  }

  isAvailable(): boolean {
    return this.provider.isAvailable();
  }

  /**
   * One page of posts newer than `after`.
   *
   * The community guard runs HERE, before any URL is built. Arctic Shift is
   * free, so this is not a cost guard — it is a scope guard: a community that
   * is not active must not be ingested by ANY provider, or the free path
   * quietly reintroduces the data the metered path was restricted from.
   */
  async fetchPosts(params: {
    community: string;
    after: Date | null;
    before?: Date;
    limit: number;
  }): Promise<ArcticFetchResult> {
    assertCommunityIsActive(params.community);

    const page = await this.provider.fetchPostsPage({
      subreddit: params.community,
      ...(params.after ? { after: params.after } : {}),
      ...(params.before ? { before: params.before } : {}),
      limit: params.limit,
      sort: "asc",
    });

    const raws = page.posts.map((p) => p.raw);
    const items: SocialPostItem[] = [];
    for (const post of page.posts) {
      const item = postToSocialItem(post, params.community);
      if (item) items.push(item);
    }

    const newest = newestOf(page.posts);
    return {
      items,
      receivedCount: page.receivedCount,
      hasMore: page.hasMore,
      lagSeconds: archiveLagSeconds(raws),
      newestSeenAt: newest.at,
      newestSeenId: newest.id,
    };
  }

  /**
   * One page of comments newer than `after`, across the whole community.
   *
   * SUBREDDIT-WIDE, not per-thread. The metered provider billed per row and
   * took a thread URL, so naming the thread was the only way to make a
   * one-minute cadence affordable — hence the priority rotation, the idle
   * retirement and the per-thread cursors. None of that is needed here: one
   * ascending request returns every new comment in the community regardless of
   * which thread it landed in, which is both cheaper in requests and strictly
   * more complete, since it cannot miss a conversation that was never selected
   * for the rotation.
   */
  async fetchComments(params: {
    community: string;
    after: Date | null;
    before?: Date;
    limit: number;
    /** Narrow to one thread. Normally omitted. */
    threadId?: string;
  }): Promise<ArcticFetchResult> {
    assertCommunityIsActive(params.community);

    const page = await this.provider.fetchCommentsPage({
      subreddit: params.community,
      ...(params.after ? { after: params.after } : {}),
      ...(params.before ? { before: params.before } : {}),
      ...(params.threadId ? { linkId: params.threadId } : {}),
      limit: params.limit,
      sort: "asc",
    });

    const raws = page.comments.map((c) => c.raw);
    const items: SocialPostItem[] = [];
    for (const comment of page.comments) {
      const item = commentToSocialItem(comment, params.threadId, params.community);
      if (item) items.push(item);
    }

    const newest = newestOf(page.comments);
    return {
      items,
      receivedCount: page.receivedCount,
      hasMore: page.hasMore,
      lagSeconds: archiveLagSeconds(raws),
      newestSeenAt: newest.at,
      newestSeenId: newest.id,
    };
  }
}

/** The process-wide source. Constructed lazily so config errors surface on use. */
let cached: ArcticShiftSocialSource | undefined;

export function getArcticShiftSource(): ArcticShiftSocialSource {
  if (!cached) cached = new ArcticShiftSocialSource();
  return cached;
}

/** Tests only. */
export function __resetArcticShiftSourceForTests(): void {
  cached = undefined;
}
