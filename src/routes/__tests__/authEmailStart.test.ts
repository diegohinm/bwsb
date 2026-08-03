import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import express from "express";

import {
  authRouter,
  emailFailureResponse,
  emailStartAllowed,
  __resetEmailStartLimiter,
} from "../auth.routes.js";
import { EmailDeliveryError } from "../../services/email/EmailDeliveryError.js";

/**
 * POST /auth/email/start used to answer 200 no matter what — including when
 * Gmail rejected the credentials — so the frontend told people to check an
 * inbox that would never receive anything.
 *
 * These run the REAL router over a real HTTP server. The 400 and 429 paths
 * return before any database or SMTP work, so they are end-to-end here; the
 * 502/500 mapping is covered through the exported classifier, because reaching
 * it requires a database the unit suite deliberately does not have.
 */

let server: Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/auth", authRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  __resetEmailStartLimiter();
});

async function start(email: unknown) {
  const response = await fetch(`${baseUrl}/auth/email/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body, headers: response.headers };
}

describe("POST /auth/email/start — validation", () => {
  it("rejects a malformed address with 400", async () => {
    for (const bad of ["", "   ", "not-an-email", "missing@domain", "@example.com", "a b@c.com"]) {
      const { status, body } = await start(bad);
      assert.equal(status, 400, `${JSON.stringify(bad)} should be rejected`);
      assert.match(String(body.error), /valid email/i);
      __resetEmailStartLimiter();
    }
  });

  it("rejects a non-string body value with 400 rather than crashing", async () => {
    const { status } = await start(12345);
    assert.equal(status, 400);
  });

  it("never reports success in the body of a rejection", async () => {
    const { body } = await start("nope");
    assert.equal(body.data, undefined);
    assert.equal(body.ok, undefined);
  });
});

/**
 * Exercised directly rather than over HTTP: the IP limiter in front of this one
 * is shared by every case in the file (one loopback address), so driving the
 * per-address budget through real requests would measure the wrong limiter.
 * This is the same function the route calls.
 */
describe("per-address rate limiting", () => {
  it("allows a burst and then refuses, with a retry hint", () => {
    const email = "flood@example.com";
    const results = Array.from({ length: 6 }, () => emailStartAllowed(email));

    assert.deepEqual(
      results.map((r) => r.allowed),
      [true, true, true, true, true, false],
      "the sixth request in the window must be refused",
    );
    assert.ok(results[5].retryAfter > 0, "a refusal must say when to retry");
  });

  it("gives every address its own budget, so one sender cannot block another", () => {
    for (let i = 0; i < 6; i += 1) emailStartAllowed("noisy@example.com");
    assert.equal(emailStartAllowed("quiet@example.com").allowed, true);
  });

  it("starts fresh after the limiter is reset", () => {
    for (let i = 0; i < 6; i += 1) emailStartAllowed("burst@example.com");
    assert.equal(emailStartAllowed("burst@example.com").allowed, false);

    __resetEmailStartLimiter();
    assert.equal(emailStartAllowed("burst@example.com").allowed, true);
  });
});

describe("POST /auth/email/start — IP rate limiting", () => {
  it("eventually answers 429 with Retry-After from one address", async () => {
    // The IP limiter allows 10 per window and is shared with the cases above,
    // so this only asserts that the endpoint DOES refuse and says when to retry.
    let throttled: { status: number; headers: Headers } | null = null;
    for (let i = 0; i < 30 && !throttled; i += 1) {
      const result = await start(`burst${i}@example.com`);
      if (result.status === 429) throttled = result;
    }

    assert.ok(throttled, "the endpoint must refuse an unbounded burst");
    assert.ok(throttled.headers.get("retry-after"), "a 429 must say when to retry");
  });
});

describe("failure mapping", () => {
  it("maps a delivery failure to 502", () => {
    const mapped = emailFailureResponse(
      new EmailDeliveryError("Unable to deliver email"),
      "Unable to send verification email",
    );
    assert.equal(mapped.status, 502);
    assert.equal(mapped.message, "Unable to send verification email");
  });

  it("maps anything else to 500", () => {
    assert.equal(
      emailFailureResponse(new Error("boom"), "Unable to send verification email").status,
      500,
    );
  });

  it("returns a generic message, never the SMTP wording", () => {
    const smtp = new EmailDeliveryError("Unable to deliver email", {
      cause: new Error("535-5.7.8 Username and Password not accepted"),
    });
    const mapped = emailFailureResponse(smtp, "Unable to send verification email");

    assert.ok(!mapped.message.includes("535"));
    assert.ok(!mapped.message.includes("Username and Password"));
    assert.ok(!mapped.message.includes("@"), "the sending account must not leak");
  });

  it("is never a 2xx — a failed send cannot be reported as success", () => {
    for (const err of [new EmailDeliveryError(), new Error("boom"), "string failure", null]) {
      const mapped = emailFailureResponse(err, "Unable to send verification email");
      assert.ok(mapped.status >= 500, `${String(err)} must not map to a success status`);
    }
  });
});
