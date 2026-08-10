import { TickerSourceError } from "./types.js";

/**
 * Fetching a catalog source.
 *
 * Plain `fetch` with an AbortController — no HTTP client dependency is worth
 * adding to GET three public files once a day.
 *
 * THE BODY IS NEVER LOGGED. These payloads are 350 KB to 1.4 MB, and the
 * failure mode that matters most is a CDN returning an HTML error page with a
 * 200 status: logging it would bury the run log in markup while telling you
 * nothing the parser will not say more precisely.
 */
export async function downloadText(
  sourceId: string,
  url: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "text/plain, application/json", "user-agent": "YOLOPulse-TickerCatalog/2.0" },
    });

    if (!response.ok) {
      throw new TickerSourceError(
        sourceId,
        `source responded ${response.status} ${response.statusText}`,
      );
    }

    const text = await response.text();
    if (!text || text.trim().length === 0) {
      throw new TickerSourceError(sourceId, "source returned an empty body");
    }
    return text;
  } catch (err) {
    if (err instanceof TickerSourceError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new TickerSourceError(sourceId, `source did not respond within ${timeoutMs}ms`);
    }
    // Only the message travels. A URL can carry credentials in other
    // deployments, and the response body is never useful here.
    throw new TickerSourceError(
      sourceId,
      `source download failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Split a pipe-delimited directory into a header index and its data lines.
 *
 * Both Nasdaq Trader files share this shape, including the pipe-padded
 * `File Creation Time:` footer that a naive split turns into a record with an
 * empty symbol.
 */
export function readPipeDelimited(
  sourceId: string,
  text: string,
  requiredColumns: readonly string[],
): { index: Map<string, number>; rows: string[]; sourceCreatedAt: Date | null } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new TickerSourceError(sourceId, "source contains no lines");
  }

  const header = lines[0]!.split("|").map((h) => h.trim());
  const index = new Map(header.map((name, i) => [name, i]));
  const missing = requiredColumns.filter((c) => !index.has(c));
  if (missing.length > 0) {
    throw new TickerSourceError(
      sourceId,
      `source header is missing required column(s): ${missing.join(", ")}`,
    );
  }

  const rows = lines.slice(1);
  let sourceCreatedAt: Date | null = null;
  while (rows.length > 0 && isFooter(rows[rows.length - 1]!)) {
    sourceCreatedAt = parseSourceCreatedAt(rows.pop()!) ?? sourceCreatedAt;
  }

  return { index, rows: rows.filter((line) => !isFooter(line)), sourceCreatedAt };
}

export function isFooter(line: string): boolean {
  return line.trimStart().toLowerCase().startsWith("file creation time:");
}

/** `File Creation Time: 0807202621:31` → a Date, or null if unreadable. */
export function parseSourceCreatedAt(line: string): Date | null {
  const match = /File Creation Time:\s*(\d{2})(\d{2})(\d{4})(\d{2}):(\d{2})/.exec(line);
  if (!match) return null;
  const [, mm, dd, yyyy, hh, min] = match;
  const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min));
  return Number.isNaN(date.getTime()) ? null : date;
}
