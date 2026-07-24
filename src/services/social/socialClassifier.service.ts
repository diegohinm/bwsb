import type {
  SocialContentType,
  SocialSentiment,
  SocialStance,
} from "./socialData.types.js";

/**
 * Deterministic, rule-based sentiment/stance classifier — an MVP baseline with
 * a clean interface so an ML/LLM classifier can drop in later. Everything is
 * computed server-side; the frontend never classifies.
 */

const BULLISH = [
  "bullish", "buy", "calls", "call", "moon", "squeeze", "breakout", "tendies",
  "long", "all in", "yolo", "loading", "rip", "rocket", "green", "up only",
  "printing", "pump",
];

const BEARISH = [
  "bearish", "puts", "put", "short", "dump", "tank", "crash", "overvalued",
  "fraud", "scam", "dilution", "red", "sell", "bag", "bagholder", "drilling",
  "rug", "bubble",
];

/** Title/flair words that mark a gain/loss/position screenshot. */
const SCREENSHOT_HINTS = ["yolo", "gain", "loss", "position", "screenshot", "porn"];

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)(\?|$)/i;
const IMAGE_HOST = /(i\.redd\.it|preview\.redd\.it|imgur\.com|i\.imgur\.com)/i;

function countHits(haystack: string, needles: string[]): number {
  let n = 0;
  for (const word of needles) {
    // Word-ish boundary match so "call" doesn't fire inside "recall".
    const re = new RegExp(`(^|[^a-z])${escapeRe(word)}([^a-z]|$)`, "gi");
    const matches = haystack.match(re);
    if (matches) n += matches.length;
  }
  return n;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ClassifierInput {
  title?: string;
  text?: string;
  flair?: string;
  url?: string;
  /** Set when the provider already told us this is a comment. */
  isComment?: boolean;
  /** Set when the provider flags media/image content. */
  hasMedia?: boolean;
}

export interface ClassifierResult {
  sentiment: SocialSentiment;
  stance: SocialStance;
  confidence: number;
  isScreenshot: boolean;
  contentType: SocialContentType;
}

export function classifySocialItem(input: ClassifierInput): ClassifierResult {
  const title = input.title ?? "";
  const text = input.text ?? "";
  const flair = input.flair ?? "";
  const url = input.url ?? "";
  const haystack = `${title} ${text} ${flair}`.toLowerCase();

  const bull = countHits(haystack, BULLISH);
  const bear = countHits(haystack, BEARISH);
  const net = bull - bear;
  const total = bull + bear;

  let stance: SocialStance = "neutral";
  if (net > 0) stance = "bullish";
  else if (net < 0) stance = "bearish";

  const sentiment: SocialSentiment =
    stance === "bullish"
      ? "positive"
      : stance === "bearish"
        ? "negative"
        : "neutral";

  // Confidence scales with how lopsided and how strong the keyword signal is.
  const confidence =
    total === 0
      ? 0.2
      : Math.min(0.95, 0.4 + (Math.abs(net) / total) * 0.4 + Math.min(total, 5) * 0.05);

  const isScreenshot =
    Boolean(input.hasMedia) ||
    IMAGE_EXT.test(url) ||
    IMAGE_HOST.test(url) ||
    SCREENSHOT_HINTS.some((h) => `${title} ${flair}`.toLowerCase().includes(h));

  let contentType: SocialContentType;
  if (input.isComment) contentType = "comment";
  else if (isScreenshot) contentType = "screenshot";
  else if (url && !text) contentType = "link";
  else if (title || text) contentType = "post";
  else contentType = "unknown";

  return {
    sentiment,
    stance,
    confidence: Math.round(confidence * 100) / 100,
    isScreenshot,
    contentType,
  };
}
