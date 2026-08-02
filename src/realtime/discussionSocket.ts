import type { Server } from "node:http";

import { WebSocketServer, WebSocket } from "ws";

import { env } from "../config/env.js";
import { discussionHub } from "./discussionHub.js";
import { discussionSource } from "./discussionSource.js";
import type { DiscussionFrame } from "./discussionEvents.js";

/**
 * WEBSOCKET TRANSPORT for the Discussion feed.
 *
 *   ws://<api>/ws/discussion?ticker=MSFT
 *
 * The socket is a delta channel only: the client loads its snapshot over REST
 * and this pushes what changes afterwards. That is what makes the feed cheap —
 * nothing re-sends the whole feed, ever.
 *
 * It is PUBLIC, like the ticker pages it serves, and read-only: the server
 * ignores anything a client sends except a ticker switch, so a socket cannot be
 * used to reach anything a GET could not.
 *
 * A heartbeat every 25s keeps intermediaries from silently dropping an idle
 * connection, and a dead-peer sweep closes sockets that stopped answering —
 * without it, a laptop that slept would hold a subscription forever.
 */

const PATH = "/ws/discussion";
const HEARTBEAT_MS = 25_000;
/** Rejects anything not shaped like a symbol before it reaches a query. */
const SYMBOL = /^[A-Z][A-Z.\-]{0,9}$/;

type Live = WebSocket & { isAlive?: boolean; unsubscribe?: () => void; ticker?: string };

function send(socket: WebSocket, frame: DiscussionFrame): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(frame));
}

function attachTicker(socket: Live, raw: string | null): void {
  const ticker = (raw ?? "").trim().toUpperCase();
  if (!SYMBOL.test(ticker)) {
    // A bad symbol closes the socket rather than silently subscribing to
    // nothing — the client should retry with a valid one, not sit connected to
    // a stream that can never deliver.
    socket.close(1008, "Invalid ticker");
    return;
  }

  socket.unsubscribe?.();
  socket.ticker = ticker;
  socket.unsubscribe = discussionHub.subscribe(ticker, (frame) => send(socket, frame));

  send(socket, {
    kind: "hello",
    ticker,
    transport: "websocket",
    sourceMode: discussionSource.mode,
    pollIntervalMs: discussionSource.intervalMs,
  });
}

export function attachDiscussionSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: PATH });

  wss.on("connection", (raw, request) => {
    const socket = raw as Live;
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });

    const url = new URL(request.url ?? PATH, env.BACKEND_URL);
    attachTicker(socket, url.searchParams.get("ticker"));

    // The one message a client may send: follow a different symbol on the same
    // connection, so switching tickers does not cost a reconnect.
    socket.on("message", (data) => {
      try {
        const parsed: unknown = JSON.parse(String(data));
        if (
          parsed &&
          typeof parsed === "object" &&
          (parsed as { type?: unknown }).type === "subscribe"
        ) {
          const next = (parsed as { ticker?: unknown }).ticker;
          if (typeof next === "string") attachTicker(socket, next);
        }
      } catch {
        // Unparseable input is ignored: this channel has no command surface.
      }
    });

    socket.on("close", () => socket.unsubscribe?.());
    socket.on("error", () => socket.unsubscribe?.());
  });

  // Only run the change source while at least one socket or SSE client exists.
  discussionSource.start();

  const heartbeat = setInterval(() => {
    for (const raw of wss.clients) {
      const socket = raw as Live;
      if (socket.isAlive === false) {
        socket.unsubscribe?.();
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
      if (socket.ticker) {
        discussionHub.send(socket.ticker, { kind: "heartbeat", at: new Date().toISOString() });
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  wss.on("close", () => clearInterval(heartbeat));

  console.log(`[discussion] websocket listening on ${PATH}`);
  return wss;
}
