import { query, queryOne } from "../lib/db.js";
import type { RedditPost } from "../types/domain.js";

/** Data access for reddit posts and comments. */
export const postsRepository = {
  findById(redditPostId: string): Promise<RedditPost | null> {
    return queryOne<RedditPost>(
      `SELECT * FROM public.reddit_posts WHERE reddit_post_id = $1`,
      [redditPostId],
    );
  },

  recent(limit = 50): Promise<RedditPost[]> {
    return query<RedditPost>(
      `SELECT * FROM public.reddit_posts ORDER BY reddit_created_at DESC NULLS LAST LIMIT $1`,
      [limit],
    );
  },

  commentsForPost(redditPostId: string) {
    return query(
      `SELECT reddit_comment_id, reddit_post_id, subreddit, author_hash, body_excerpt, score, reddit_created_at
       FROM public.reddit_comments WHERE reddit_post_id = $1 ORDER BY score DESC`,
      [redditPostId],
    );
  },
};
