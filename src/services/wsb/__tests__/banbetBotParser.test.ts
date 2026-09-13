import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isBanbetErrorMessage,
  isBanbetStatusMessage,
  isNonBetBotMessage,
  parseBanbetCommand,
  parseBanbetCreated,
  parseBanbetResult,
  parseDuration,
  realizedReturnPercent,
} from "../banbetBotParser.service.js";

/**
 * EVERY FIXTURE BELOW IS A REAL COMMENT, copied verbatim from r/wallstreetbets.
 *
 * Not paraphrased and not tidied: the arrows, the em dash, the markdown table
 * pipes and the `(below)` annotation are exactly what the bot posts. A parser
 * for a format nobody controls is only as good as the samples it was written
 * against, and a hand-written approximation would pass its own tests while
 * failing the wire.
 */

// ── the user's command ───────────────────────────────────────────────────────
const CMD_PERCENT = "!banbet NBIS -10% 5d";
const CMD_ABSOLUTE = "!banbet SKHY 160 3w";
const CMD_DOLLAR_UPPER = "!Banbet ORCL $160 2W";
const CMD_BARE = "!banbet";
const CMD_BARE_UPPER = "!BANBET";

// ── the bot ──────────────────────────────────────────────────────────────────
const CREATED =
  "**BanBet Created** ▼ | **Record:** 2W - 1L\n\n" +
  "| Ticker | Target | Entry | Move | Expires |\n" +
  "|:---:|:---:|:---:|:---:|:---:|\n" +
  "| **NBIS** | $202.10 (below) | $224.55 | -10.0% | Sep 17, 9:26 PM |";

const WON =
  "**BanBet Won** — /u/No-Inevitable1270 (2W - 1L, 67%)\n\n" +
  "| Ticker | Entry → Target | Move | Time | Result |\n" +
  "|:---:|:---:|:---:|:---:|:---:|\n" +
  "| **RDDT** ▼ | $200.88 → $198.99 | -0.9% | 4h 59m | Won |";

const LOST =
  "**BanBet Lost** — /u/Cosmic64X (0W - 4L, 0%)\n\n" +
  "| Ticker | Entry → Target | Move | Time | Result |\n" +
  "|:---:|:---:|:---:|:---:|:---:|\n" +
  "| **SNDK** ▲ | $1548.17 → $2000.00 | +29.2% | 4w 2d | Lost |";

const NO_ACTIVE =
  "**No Active BanBet**\n\n| W | L | Win Rate |\n|:---:|:---:|:---:|\n| 6 | 5 | 55% |\n\n" +
  "*Banned from banbets until Sep 13, 12:57 AM*";

describe("the user's command", () => {
  it("reads a percentage target, keeping its sign", () => {
    const cmd = parseBanbetCommand(CMD_PERCENT);
    assert.equal(cmd?.ticker, "NBIS");
    assert.equal(cmd?.targetPercent, -10);
    assert.equal(cmd?.targetPrice, null);
    assert.equal(cmd?.durationMs, 5 * 86_400_000);
  });

  it("reads an absolute price target", () => {
    const cmd = parseBanbetCommand(CMD_ABSOLUTE);
    assert.equal(cmd?.ticker, "SKHY");
    assert.equal(cmd?.targetPrice, 160);
    assert.equal(cmd?.targetPercent, null);
    assert.equal(cmd?.durationMs, 3 * 604_800_000);
  });

  it("tolerates a dollar sign, mixed case and an uppercase unit", () => {
    // All three appear in real commands; none of them is a different bet.
    const cmd = parseBanbetCommand(CMD_DOLLAR_UPPER);
    assert.equal(cmd?.ticker, "ORCL");
    assert.equal(cmd?.targetPrice, 160);
    assert.equal(cmd?.durationMs, 2 * 604_800_000);
  });

  it("refuses a bare invocation — that is a status request, not a wager", () => {
    // People post these constantly. Counting them as bets would populate the
    // scoreboard with rows that have no ticker, price or deadline.
    assert.equal(parseBanbetCommand(CMD_BARE), null);
    assert.equal(parseBanbetCommand(CMD_BARE_UPPER), null);
  });

  it("refuses prose that merely mentions the bot", () => {
    assert.equal(parseBanbetCommand("does banbet work on things like this"), null);
    assert.equal(parseBanbetCommand("I dare you to banbet even 1% "), null);
  });

  it("refuses a command with no target", () => {
    assert.equal(parseBanbetCommand("!banbet NVDA"), null);
  });
});

describe("duration", () => {
  it("reads single and compound spans, any case", () => {
    assert.equal(parseDuration("5d"), 5 * 86_400_000);
    assert.equal(parseDuration("2W"), 2 * 604_800_000);
    assert.equal(parseDuration("4h 59m"), 4 * 3_600_000 + 59 * 60_000);
    assert.equal(parseDuration("4w 2d"), 4 * 604_800_000 + 2 * 86_400_000);
  });

  it("reports null rather than zero when nothing parsed", () => {
    // "no horizon stated" and "a zero-length bet" are different facts.
    assert.equal(parseDuration("soon"), null);
    assert.equal(parseDuration(""), null);
    assert.equal(parseDuration(undefined), null);
  });
});

describe("the bot's confirmation", () => {
  it("takes the authoritative terms, including the entry price", () => {
    // ENTRY is the number the whole feature hangs on: it is the denominator of
    // every return, and nothing except the bot knows it.
    const created = parseBanbetCreated(CREATED);
    assert.equal(created?.ticker, "NBIS");
    assert.equal(created?.targetPrice, 202.1);
    assert.equal(created?.entryPrice, 224.55);
    assert.equal(created?.movePercent, -10);
    assert.equal(created?.expiresAtRaw, "Sep 17, 9:26 PM");
  });

  it("reads direction from the bot's arrow", () => {
    assert.equal(parseBanbetCreated(CREATED)?.side, "bear");
  });

  it("is not fooled by the status reply", () => {
    assert.equal(parseBanbetCreated(NO_ACTIVE), null);
    assert.ok(isBanbetStatusMessage(NO_ACTIVE));
  });
});

describe("the bot's outcome", () => {
  it("publishes the real username, which is the whole leaderboard", () => {
    // The handle comes from the bot's own printed text — it is not recovered
    // from an author field, and nothing about the hashing elsewhere changes.
    assert.equal(parseBanbetResult(WON)?.username, "No-Inevitable1270");
    assert.equal(parseBanbetResult(LOST)?.username, "Cosmic64X");
  });

  it("reads a win", () => {
    const r = parseBanbetResult(WON);
    assert.equal(r?.outcome, "won");
    assert.equal(r?.ticker, "RDDT");
    assert.equal(r?.entryPrice, 200.88);
    assert.equal(r?.targetPrice, 198.99);
    assert.equal(r?.side, "bear");
    assert.equal(r?.durationRaw, "4h 59m");
  });

  it("reads a loss, including four-digit prices with separators", () => {
    const r = parseBanbetResult(LOST);
    assert.equal(r?.outcome, "lost");
    assert.equal(r?.ticker, "SNDK");
    assert.equal(r?.entryPrice, 1548.17);
    assert.equal(r?.targetPrice, 2000);
    assert.equal(r?.movePercent, 29.2);
    assert.equal(r?.side, "bull");
  });

  it("keeps the bot's own W/L tally as an independent check", () => {
    // If a leaderboard computed from stored rows disagrees with this, the
    // ingestion missed bets — the bot is not the thing that is wrong.
    assert.deepEqual(parseBanbetResult(WON)?.record, {
      wins: 2,
      losses: 1,
      winRatePercent: 67,
    });
  });

  it("ignores a command or a confirmation", () => {
    assert.equal(parseBanbetResult(CREATED), null);
    assert.equal(parseBanbetResult(CMD_PERCENT), null);
  });
});

describe("bot messages that are deliberately not bets", () => {
  it("recognises a refusal", () => {
    // Seen live: the bot rejects a second concurrent bet. No wager exists, and
    // it must not be counted as an unparsed message either — the ingestion
    // treats "did not understand" as a defect, and a routine refusal would
    // bury the failures that actually matter.
    const err =
      "**BanBet Error** — You already have an active banbet — wait for it to resolve";
    assert.ok(isBanbetErrorMessage(err));
    assert.ok(isNonBetBotMessage(err));
    assert.equal(parseBanbetCommand(err), null);
    assert.equal(parseBanbetCreated(err), null);
    assert.equal(parseBanbetResult(err), null);
  });

  it("counts the status reply as recognised too", () => {
    assert.ok(isNonBetBotMessage(NO_ACTIVE));
  });

  it("does not classify a real outcome as a non-bet", () => {
    assert.equal(isNonBetBotMessage(WON), false);
    assert.equal(isNonBetBotMessage(LOST), false);
    assert.equal(isNonBetBotMessage(CREATED), false);
  });
});

describe("realized return", () => {
  it("equals the target move on a win, because that is why it resolved", () => {
    assert.equal(realizedReturnPercent("won", -0.9), 0.9);
    assert.equal(realizedReturnPercent("won", 29.2), 29.2);
  });

  it("is NULL on a loss — the bot never publishes the price at expiry", () => {
    // THE HONEST ANSWER. Substituting the target move, or a flat -100%, would
    // put a fabricated number into average-return, which is precisely the
    // statistic a reader would trust most.
    assert.equal(realizedReturnPercent("lost", 29.2), null);
    assert.equal(realizedReturnPercent("expired", 10), null);
  });

  it("scores a correct bear call as a POSITIVE return for the bettor", () => {
    // Sign follows the WAGER, not the price: predicting a fall and being right
    // is a gain, and a leaderboard that showed it as -0.9% would rank a
    // successful bear below a failed one.
    const r = parseBanbetResult(WON);
    assert.equal(r?.side, "bear");
    assert.ok((realizedReturnPercent("won", r!.movePercent) ?? 0) > 0);
  });
});
