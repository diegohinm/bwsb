import type { NextFunction, Request, Response } from "express";

import {
  isScannerProviderMode,
  SCANNER_PROVIDER_MODES,
  type RedditScannerTestProvider,
} from "../providers/reddit/createTestRedditProvider.js";

/**
 * Validate + normalize the scanner request body.
 *
 * Normalization is part of the contract, not a convenience: an operator pasting
 * `r/WallStreetBets` and one typing `wallstreetbets` must produce the SAME
 * upstream call, otherwise the same subreddit gets scanned twice under two
 * names and the results look inconsistent.
 *
 * The validated value is placed on `res.locals.scannerRequest` so the
 * controller never re-reads `req.body`.
 */

export const SCANNER_SORTS = ["new", "hot", "top"] as const;
export type ScannerSort = (typeof SCANNER_SORTS)[number];

export const SCANNER_MIN_LIMIT = 1;
export const SCANNER_MAX_LIMIT = 100;

export interface ScannerRequest {
  provider: RedditScannerTestProvider;
  subreddit: string;
  sort: ScannerSort;
  limit: number;
  persist: boolean;
  includeRaw: boolean;
}

/** A subreddit name Reddit would actually accept. */
const SUBREDDIT_PATTERN = /^[a-z0-9_]{2,21}$/;

/**
 * `r/WallStreetBets`, `/r/wallstreetbets`, `  WallStreetBets  ` → `wallstreetbets`.
 * Returns null when nothing usable is left.
 */
export function normalizeSubreddit(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .trim()
    .replace(/^\/?r\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (cleaned.length === 0) return null;
  // Spaces are rejected outright rather than stripped: "wall street bets" is a
  // typo for a different community, not a formatting quirk to be guessed at.
  if (!SUBREDDIT_PATTERN.test(cleaned)) return null;
  return cleaned;
}

function badRequest(res: Response, code: string, message: string): void {
  res.status(400).json({ success: false, error: { code, message } });
}

export function validateRedditScannerRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const provider = body.provider ?? "configured";
  if (!isScannerProviderMode(provider)) {
    badRequest(
      res,
      "INVALID_PROVIDER",
      `provider must be one of: ${SCANNER_PROVIDER_MODES.join(", ")}.`,
    );
    return;
  }

  const subreddit = normalizeSubreddit(body.subreddit);
  if (!subreddit) {
    badRequest(
      res,
      "INVALID_SUBREDDIT",
      "The subreddit name is invalid. Use a name like wallstreetbets or r/wallstreetbets.",
    );
    return;
  }

  const sortValue = body.sort ?? "new";
  if (
    typeof sortValue !== "string" ||
    !(SCANNER_SORTS as readonly string[]).includes(sortValue)
  ) {
    badRequest(res, "INVALID_SORT", `sort must be one of: ${SCANNER_SORTS.join(", ")}.`);
    return;
  }

  let limit = 20;
  if (body.limit !== undefined && body.limit !== null && body.limit !== "") {
    const parsed = Number(body.limit);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      badRequest(res, "INVALID_LIMIT", "limit must be a whole number.");
      return;
    }
    // Rejected, not clamped: silently returning 100 for a requested 500 would
    // make the operator think the upstream only had 100 posts.
    if (parsed < SCANNER_MIN_LIMIT || parsed > SCANNER_MAX_LIMIT) {
      badRequest(
        res,
        "INVALID_LIMIT",
        `limit must be between ${SCANNER_MIN_LIMIT} and ${SCANNER_MAX_LIMIT}.`,
      );
      return;
    }
    limit = parsed;
  }

  const scannerRequest: ScannerRequest = {
    provider,
    subreddit,
    sort: sortValue as ScannerSort,
    limit,
    persist: body.persist === true,
    includeRaw: body.includeRaw === true,
  };

  res.locals.scannerRequest = scannerRequest;
  next();
}
