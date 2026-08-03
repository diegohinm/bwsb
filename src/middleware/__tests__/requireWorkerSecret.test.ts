import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import express from "express";

import { internalRedditEventsRouter } from "../../routes/internalRedditEvents.routes.js";
import { discussionHub } from "../../realtime/discussionHub.js";
import type { DiscussionFrame } from "../../realtime/discussionEvents.js";

/**
 * The internal bridge is the one endpoint a stranger could use to inject
 * content into somebody's live feed, so the guard is tested as an endpoint —
 * over real HTTP, through the real router — rather than as a function.
 *
 * The secret is read from the environment at import time, so it is set before
 * the router is loaded above.
 */

const SECRET = "test-worker-secret-0123456789abcdef";
process.env.WORKER_INTERNAL_SECRET = SECRET;

let server: Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", internalRedditEventsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(body: unknown, authorization?: string) {
  const response = await fetch(`${baseUrl}/api/internal/reddit/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const validEvent = {
  type: "newPost",
  ticker: "MSFT",
  data: { id: "p1", subreddit: "wallstreetbets", title: "hello" },
};

describe("internal events authentication", () => {
  it("refuses a request with no Authorization header", async () => {
    const { status } = await post(validEvent);
    assert.equal(status, 401);
  });

  it("refuses a wrong secret", async () => {
    const { status } = await post(validEvent, "Bearer definitely-not-the-secret");
    assert.equal(status, 401);
  });

  it("refuses a non-Bearer scheme carrying the right value", async () => {
    const { status } = await post(validEvent, `Basic ${SECRET}`);
    assert.equal(status, 401);
  });

  it("refuses a secret that is merely a prefix of the real one", async () => {
    const { status } = await post(validEvent, `Bearer ${SECRET.slice(0, -1)}`);
    assert.equal(status, 401);
  });

  it("gives the same answer for every rejection", async () => {
    // A caller must not be able to tell "missing" from "wrong" from "malformed".
    const answers = await Promise.all([
      post(validEvent),
      post(validEvent, "Bearer wrong"),
      post(validEvent, "Basic something"),
    ]);
    const bodies = answers.map((a) => JSON.stringify(a.body));
    assert.equal(new Set(bodies).size, 1, "rejection responses must be indistinguishable");
  });

  it("accepts the correct secret", async () => {
    const { status } = await post(validEvent, `Bearer ${SECRET}`);
    assert.equal(status, 200);
  });
});

describe("internal events validation", () => {
  it("rejects an unknown event type", async () => {
    const { status } = await post({ ...validEvent, type: "dropTables" }, `Bearer ${SECRET}`);
    assert.equal(status, 400);
  });

  it("rejects a symbol that is not shaped like a ticker", async () => {
    for (const ticker of ["1$$", "", "waytoolongsymbol", "../etc"]) {
      const { status } = await post({ ...validEvent, ticker }, `Bearer ${SECRET}`);
      assert.equal(status, 400, `${JSON.stringify(ticker)} should be rejected`);
    }
  });

  it("requires an id on a deletion", async () => {
    const { status } = await post(
      { type: "deletedPost", ticker: "MSFT", data: {} },
      `Bearer ${SECRET}`,
    );
    assert.equal(status, 400);
  });
});

describe("internal events broadcasting", () => {
  it("delivers to the subscribers of that ticker only", async () => {
    const msft: DiscussionFrame[] = [];
    const nvda: DiscussionFrame[] = [];
    const stopA = discussionHub.subscribe("MSFT", (f) => msft.push(f));
    const stopB = discussionHub.subscribe("NVDA", (f) => nvda.push(f));

    try {
      const { status, body } = await post(validEvent, `Bearer ${SECRET}`);
      assert.equal(status, 200);
      assert.equal((body as { data: { subscribers: number } }).data.subscribers, 1);

      assert.equal(msft.length, 1);
      assert.equal(nvda.length, 0, "another ticker's watcher must not see this");
    } finally {
      stopA();
      stopB();
    }
  });

  it("takes the ticker from the envelope, not the payload", async () => {
    const seen: DiscussionFrame[] = [];
    const stop = discussionHub.subscribe("MSFT", (f) => seen.push(f));

    try {
      // A payload claiming a different ticker must not redirect the broadcast.
      await post(
        { type: "newPost", ticker: "MSFT", data: { id: "p9", ticker: "NVDA" } },
        `Bearer ${SECRET}`,
      );
      assert.equal(seen.length, 1);
      const frame = seen[0];
      assert.equal(frame.kind, "event");
      if (frame.kind === "event" && "post" in frame.event) {
        assert.equal(frame.event.post.ticker, "MSFT");
      }
    } finally {
      stop();
    }
  });

  it("succeeds even when nobody is listening", async () => {
    const { status, body } = await post(
      { ...validEvent, ticker: "ZZZZ" },
      `Bearer ${SECRET}`,
    );
    // The worker must never treat "no audience" as a failure worth retrying.
    assert.equal(status, 200);
    assert.equal((body as { data: { subscribers: number } }).data.subscribers, 0);
  });
});
