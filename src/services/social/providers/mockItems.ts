import { TRACKED_SUBREDDITS } from "../subreddits.js";
import { classifySocialItem } from "../socialClassifier.service.js";
import { extractTickersFrom } from "../tickerExtractor.service.js";
import type {
  PulseTimeframe,
  SocialPostItem,
} from "../socialData.types.js";

/**
 * DEMO DATA — synthetic Reddit-like posts/comments used by the mock provider
 * (and as the universal fallback). Nothing here is scraped. Items are built
 * from realistic title templates that include tickers and bullish/bearish
 * language, then run through the SAME classifier + ticker extractor the real
 * providers use — so the mock exercises the whole pipeline and reads true.
 *
 * Deterministic: everything is seeded by subreddit/index/timeframe so the page
 * doesn't flicker between reloads and two clients see the same snapshot.
 */

/** Deterministic 32-bit FNV-1a hash. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const rand = (seed: string) => hash(seed) / 0xffffffff;
const randInt = (seed: string, min: number, max: number) =>
  min + Math.floor(rand(seed) * (max - min + 1));
const pick = <T>(seed: string, arr: readonly T[]): T => arr[randInt(seed, 0, arr.length - 1)];

/** How many items a timeframe carries, relative to 1h. */
const TIMEFRAME_VOLUME: Record<PulseTimeframe, number> = {
  "1h": 1,
  "6h": 3,
  "24h": 6,
  "7d": 12,
};

/** Window length in ms, so createdAt spreads across the timeframe. */
const TIMEFRAME_MS: Record<PulseTimeframe, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

/** Tickers each community realistically talks about, so the mock reads true. */
const SUBREDDIT_TICKERS: Record<string, string[]> = {
  wallstreetbets: ["NVDA", "TSLA", "GME", "PLTR", "SPY", "AMD"],
  stocks: ["NVDA", "AMD", "INTC", "MU", "TSLA", "RDDT"],
  investing: ["SPY", "QQQ", "NVDA", "INTC", "AAPL"],
  options: ["SPY", "QQQ", "NVDA", "TSLA", "AMD", "HOOD"],
  pennystocks: ["POET", "SOFI", "AMC", "HOOD", "MARA"],
  Shortsqueeze: ["GME", "AMC", "MARA", "RIOT", "SOFI"],
  ValueInvesting: ["INTC", "META", "SOFI", "AAPL"],
  SecurityAnalysis: ["INTC", "RDDT", "META", "PLTR", "MSFT"],
};

const BULL_TEMPLATES = [
  "$TICKER calls printing, loading more before earnings 🚀",
  "Why I'm all in on $TICKER — squeeze incoming",
  "$TICKER breakout confirmed, this is going to moon",
  "YOLO update: $TICKER position green, tendies secured",
  "$TICKER is the play, buying every dip",
];
const BEAR_TEMPLATES = [
  "$TICKER puts are free money, overvalued garbage",
  "$TICKER dilution incoming, this will dump hard",
  "Short $TICKER — the whole thing is a bubble",
  "Loss porn: $TICKER bagholder down bad, selling",
  "$TICKER earnings will tank it, red days ahead",
];
const NEUTRAL_TEMPLATES = [
  "$TICKER DD: valuation and margin of safety breakdown",
  "Thoughts on $TICKER after the latest 10-Q?",
  "$TICKER earnings recap — mixed guidance",
  "Long-term $TICKER thesis, holding through volatility",
  "$TICKER vs peers: a fundamentals comparison",
];
const COMMENT_TEMPLATES = [
  "This is the way. $TICKER to the moon 🚀",
  "Overvalued imo, $TICKER puts printing next week",
  "Solid DD, been holding $TICKER for months",
  "Not financial advice but $TICKER calls looking juicy",
  "Bagholding $TICKER, thinking about cutting losses",
];

function fill(template: string, ticker: string): string {
  return template.replace(/\$TICKER/g, `$${ticker}`);
}

/** Build a deterministic set of normalized demo items for a timeframe. */
export function buildMockItems(timeframe: PulseTimeframe): SocialPostItem[] {
  const volume = TIMEFRAME_VOLUME[timeframe];
  const windowMs = TIMEFRAME_MS[timeframe];
  // Fixed "now" derived from the timeframe so output is stable across calls.
  const now = 1_700_000_000_000;
  const items: SocialPostItem[] = [];

  for (const sub of TRACKED_SUBREDDITS) {
    const tickers = SUBREDDIT_TICKERS[sub.name] ?? ["SPY"];
    const postCount = randInt(`pc:${sub.name}:${timeframe}`, 6, 14) * volume;
    const commentCount = postCount * randInt(`cc:${sub.name}:${timeframe}`, 2, 5);

    // Per-subreddit momentum bias in [-0.6, 0.6]. Positive skews activity toward
    // the newer half of the window, so the aggregator reads real (non-zero)
    // intra-window momentum instead of a flat 0.
    const bias = rand(`bias:${sub.name}:${timeframe}`) * 1.2 - 0.6;
    const skew = (r: number) => (bias >= 0 ? r ** (1 + bias * 2) : 1 - (1 - r) ** (1 - bias * 2));

    // Value-oriented subs skew neutral/analytical; hype subs skew bullish.
    const valueSub =
      sub.name === "ValueInvesting" ||
      sub.name === "SecurityAnalysis" ||
      sub.name === "investing";

    for (let i = 0; i < postCount; i += 1) {
      const seed = `${sub.name}:post:${timeframe}:${i}`;
      const ticker = pick(`${seed}:tkr`, tickers);
      const roll = rand(`${seed}:mood`);
      const templates = valueSub
        ? roll < 0.6
          ? NEUTRAL_TEMPLATES
          : roll < 0.8
            ? BULL_TEMPLATES
            : BEAR_TEMPLATES
        : roll < 0.55
          ? BULL_TEMPLATES
          : roll < 0.8
            ? NEUTRAL_TEMPLATES
            : BEAR_TEMPLATES;
      const title = fill(pick(`${seed}:tpl`, templates), ticker);
      const isShot = rand(`${seed}:shot`) < 0.15;
      const url = isShot ? `https://i.redd.it/${hash(seed).toString(36)}.png` : undefined;
      const createdAt = new Date(now - Math.floor(skew(rand(`${seed}:t`)) * windowMs)).toISOString();
      const cls = classifySocialItem({ title, url, hasMedia: isShot });
      const extracted = extractTickersFrom(title);

      items.push({
        id: `mock_${sub.name}_p${i}_${timeframe}`,
        provider: "mock",
        source: "mock",
        subreddit: sub.name,
        type: cls.contentType,
        title,
        url,
        authorHash: `anon_${(hash(`${seed}:author`) % 100000).toString(36)}`,
        score: randInt(`${seed}:score`, 5, 4200),
        numComments: randInt(`${seed}:nc`, 0, 900),
        createdAt,
        tickers: extracted.length ? extracted : [ticker],
        sentiment: cls.sentiment,
        stance: cls.stance,
        confidence: cls.confidence,
        isScreenshot: cls.isScreenshot,
      });
    }

    for (let i = 0; i < commentCount; i += 1) {
      const seed = `${sub.name}:cmt:${timeframe}:${i}`;
      const ticker = pick(`${seed}:tkr`, tickers);
      const text = fill(pick(`${seed}:tpl`, COMMENT_TEMPLATES), ticker);
      const createdAt = new Date(now - Math.floor(skew(rand(`${seed}:t`)) * windowMs)).toISOString();
      const cls = classifySocialItem({ text, isComment: true });
      const extracted = extractTickersFrom(text);

      items.push({
        id: `mock_${sub.name}_c${i}_${timeframe}`,
        provider: "mock",
        source: "mock",
        subreddit: sub.name,
        type: "comment",
        text,
        authorHash: `anon_${(hash(`${seed}:author`) % 100000).toString(36)}`,
        score: randInt(`${seed}:score`, 0, 800),
        createdAt,
        tickers: extracted.length ? extracted : [ticker],
        sentiment: cls.sentiment,
        stance: cls.stance,
        confidence: cls.confidence,
        isScreenshot: false,
      });
    }
  }

  return items;
}
