/**
 * smartEarly.service.ts
 *
 * Identifies anonymized authors with a strong track record of resolved signals
 * ("smart early" movers) and a helper to decide whether an author's signal
 * preceded broad crowd attention. Operates only on anonymized author hashes.
 */

export interface AuthorTrackRecord {
  author_hash: string;
  resolved_signals: number;
  hit_rate: number; // 0..1
}

export interface SmartEarlyOptions {
  minResolved?: number;
  minHitRate?: number;
}

/** Filter authors that meet minimum resolved-signal and hit-rate thresholds. */
export function findSmartEarlyAuthors(
  authors: AuthorTrackRecord[],
  opts: SmartEarlyOptions = {},
): AuthorTrackRecord[] {
  const minResolved = opts.minResolved ?? 20;
  const minHitRate = opts.minHitRate ?? 0.6;

  return authors
    .filter((a) => a.resolved_signals >= minResolved && a.hit_rate >= minHitRate)
    .sort((a, b) => b.hit_rate - a.hit_rate || b.resolved_signals - a.resolved_signals);
}

/** True when the author signaled strictly before broad crowd attention rose. */
export function isEarlyMention(authorSignaledAt: Date, crowdAttentionRoseAt: Date): boolean {
  return authorSignaledAt.getTime() < crowdAttentionRoseAt.getTime();
}
