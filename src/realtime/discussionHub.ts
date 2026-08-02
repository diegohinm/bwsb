import type { DiscussionEvent, DiscussionFrame } from "./discussionEvents.js";

/**
 * THE FAN-OUT LAYER.
 *
 * One process-wide hub. Producers call `publish`; transports (WebSocket, SSE)
 * call `subscribe` and get a function to stop. Neither side knows anything
 * about the other, which is the whole point:
 *
 *   - a future Mindcase/Arctic Shift/Reddit push adapter publishes here and the
 *     frontend does not change;
 *   - a future transport subscribes here and the producers do not change.
 *
 * Subscriptions are keyed by TICKER, so a socket watching MSFT is never woken
 * for NVDA traffic. The hub also reports whether anyone is listening at all, so
 * the source can stop doing work when the feed is unwatched.
 */

export type DiscussionListener = (frame: DiscussionFrame) => void;

class DiscussionHub {
  /** ticker (upper) → listeners */
  private readonly byTicker = new Map<string, Set<DiscussionListener>>();
  private published = 0;

  subscribe(ticker: string, listener: DiscussionListener): () => void {
    const key = ticker.toUpperCase();
    let set = this.byTicker.get(key);
    if (!set) {
      set = new Set();
      this.byTicker.set(key, set);
    }
    set.add(listener);

    return () => {
      const current = this.byTicker.get(key);
      if (!current) return;
      current.delete(listener);
      // Drop the empty bucket so `watchedTickers` stays an accurate answer to
      // "what is anyone actually looking at right now".
      if (current.size === 0) this.byTicker.delete(key);
    };
  }

  publish(event: DiscussionEvent): void {
    const listeners = this.byTicker.get(event.ticker.toUpperCase());
    if (!listeners || listeners.size === 0) return;
    this.published += 1;
    const frame: DiscussionFrame = { kind: "event", event };
    for (const listener of listeners) {
      try {
        listener(frame);
      } catch (err) {
        // One broken socket must never stop the others from being served.
        console.error("[discussion] listener failed:", err);
      }
    }
  }

  /** Send a non-event frame (heartbeat) to everyone watching a ticker. */
  send(ticker: string, frame: DiscussionFrame): void {
    const listeners = this.byTicker.get(ticker.toUpperCase());
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(frame);
      } catch (err) {
        console.error("[discussion] listener failed:", err);
      }
    }
  }

  /** The tickers with at least one live subscriber. */
  watchedTickers(): string[] {
    return [...this.byTicker.keys()];
  }

  subscriberCount(ticker?: string): number {
    if (ticker) return this.byTicker.get(ticker.toUpperCase())?.size ?? 0;
    let total = 0;
    for (const set of this.byTicker.values()) total += set.size;
    return total;
  }

  stats(): { tickers: number; subscribers: number; published: number } {
    return {
      tickers: this.byTicker.size,
      subscribers: this.subscriberCount(),
      published: this.published,
    };
  }
}

export const discussionHub = new DiscussionHub();
