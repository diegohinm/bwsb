import { prisma } from "../lib/prisma.js";
import { toDbRow, toDbRows } from "../lib/rows.js";
import type { RedditPost } from "../types/domain.js";

/**
 * Data access for reddit posts and comments.
 *
 * Rows are returned with their database column names (see lib/rows.ts) because
 * the ticker/research routes serialize them straight onto the wire.
 */
export const postsRepository = {
  async findById(redditPostId: string): Promise<RedditPost | null> {
    const row = await prisma.redditPosts.findUnique({ where: { redditPostId } });
    return row ? toDbRow<RedditPost>("RedditPosts", row) : null;
  },

  async recent(limit = 50): Promise<RedditPost[]> {
    const rows = await prisma.redditPosts.findMany({
      orderBy: { redditCreatedAt: { sort: "desc", nulls: "last" } },
      take: limit,
    });
    return toDbRows<RedditPost>("RedditPosts", rows);
  },

  /** Free-text search over post titles and bodies, newest first. */
  async search(term: string, limit = 5) {
    const rows = await prisma.redditPosts.findMany({
      where: {
        OR: [
          { title: { contains: term, mode: "insensitive" } },
          { bodyExcerpt: { contains: term, mode: "insensitive" } },
        ],
      },
      select: {
        redditPostId: true,
        subreddit: true,
        title: true,
        score: true,
        numComments: true,
        redditCreatedAt: true,
      },
      orderBy: { redditCreatedAt: { sort: "desc", nulls: "last" } },
      take: limit,
    });
    return toDbRows("RedditPosts", rows);
  },

  async commentsForPost(redditPostId: string) {
    const rows = await prisma.redditComments.findMany({
      where: { redditPostId },
      select: {
        redditCommentId: true,
        redditPostId: true,
        subreddit: true,
        authorHash: true,
        bodyExcerpt: true,
        score: true,
        redditCreatedAt: true,
      },
      orderBy: { score: "desc" },
    });
    return toDbRows("RedditComments", rows);
  },
};
