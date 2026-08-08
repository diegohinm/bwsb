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
 * for NVDA traffic. A subscriber can also take the GLOBAL scope and receive
 * everything — that is what the /discussion page uses.
 *
 * The hub reports whether anyone is listening at all, so the source can stop
 * doing work when nothing is being watched.
 */

/**
 * The room every event is also published to.
 *
 * Not a ticker, and not reachable as one: the symbol validator upstream rejects
 * `*`, so no client can subscribe to it by accident or by guessing.
 */
export const GLOBAL_SCOPE = "*";

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

  /**
   * Deliver an event to the ticker's watchers AND to the global room.
   *
   * A client watching MSFT and a client watching everything both receive it,
   * exactly once each. A client that somehow held both subscriptions would get
   * it twice, which is why a socket is only ever in one room.
   */
  publish(event: DiscussionEvent): void {
    const rooms = [this.byTicker.get(event.ticker.toUpperCase()), this.byTicker.get(GLOBAL_SCOPE)];
    const frame: DiscussionFrame = { kind: "event", event };
    let delivered = false;

    for (const listeners of rooms) {
      if (!listeners || listeners.size === 0) continue;
      delivered = true;
      for (const listener of listeners) {
        try {
          listener(frame);
        } catch (err) {
          // One broken socket must never stop the others from being served.
          console.error("[discussion] listener failed:", err);
        }
      }
    }

    if (delivered) this.published += 1;
  }

  /** True when at least one client is watching everything. */
  hasGlobalSubscribers(): boolean {
    return (this.byTicker.get(GLOBAL_SCOPE)?.size ?? 0) > 0;
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
