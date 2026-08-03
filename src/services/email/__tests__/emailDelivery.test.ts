import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import type { Transporter } from "nodemailer";

import {
  resetTransporter,
  sendVerificationEmail,
  setTransporterForTesting,
  verifyEmailTransport,
} from "../email.service.js";
import { EmailDeliveryError, smtpErrorDetails } from "../EmailDeliveryError.js";
import { issueTokenThenSend } from "../../auth/emailAuth.service.js";

/**
 * The bug these tests exist for: a send that failed was logged and the endpoint
 * answered 200, leaving a verification token that was valid but that nobody
 * could ever receive.
 *
 * So the properties pinned here are, in order of importance:
 *   1. a failed sendMail produces an EmailDeliveryError — never a silent resolve;
 *   2. a failed send DISCARDS the token and the caller is told;
 *   3. a token only becomes usable AFTER the mail server accepted the message;
 *   4. nothing logged or thrown carries the SMTP password.
 *
 * No real mail is sent: the transporter is a stand-in throughout.
 */

const SMTP_ENV = {
  SMTP_HOST: "smtp.gmail.com",
  SMTP_PORT: "465",
  SMTP_USER: "sender@example.com",
  SMTP_PASSWORD: "abcd efgh ijkl mnop",
  SMTP_FROM: "Support <support@example.com>",
  // Force the real SMTP path rather than the console fallback.
  DEV_EMAIL_MODE: "false",
};

const saved: Record<string, string | undefined> = {};

type SentMail = {
  from?: unknown;
  to?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
};

function fakeTransport(behaviour: {
  onSend?: (mail: SentMail) => void | Promise<void>;
  fail?: Error;
  verifyFails?: Error;
}) {
  const sent: SentMail[] = [];
  const transporter = {
    async sendMail(mail: SentMail) {
      sent.push(mail);
      if (behaviour.fail) throw behaviour.fail;
      await behaviour.onSend?.(mail);
      return { messageId: "<test@local>" };
    },
    async verify() {
      if (behaviour.verifyFails) throw behaviour.verifyFails;
      return true;
    },
  } as unknown as Transporter;
  setTransporterForTesting(transporter);
  return sent;
}

/** The shape Gmail actually returns for a bad app password. */
function gmailAuthError(): Error & Record<string, unknown> {
  const err = new Error(
    "535-5.7.8 Username and Password not accepted. For more information, go to ...",
  ) as Error & Record<string, unknown>;
  err.code = "EAUTH";
  err.responseCode = 535;
  err.command = "AUTH PLAIN";
  return err;
}

beforeEach(() => {
  for (const [key, value] of Object.entries(SMTP_ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  saved.NODE_ENV = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetTransporter();
});

describe("sending a verification email", () => {
  it("sends from SMTP_FROM with both a text and an HTML body", async () => {
    const sent = fakeTransport({});

    await sendVerificationEmail("user@example.com", "https://app.test/set-password?token=abc");

    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, "Support <support@example.com>");
    assert.equal(sent[0].to, "user@example.com");
    assert.ok(typeof sent[0].text === "string" && sent[0].text.length > 0);
    assert.ok(typeof sent[0].html === "string" && sent[0].html.length > 0);
  });

  it("turns a Gmail EAUTH into an EmailDeliveryError instead of resolving", async () => {
    fakeTransport({ fail: gmailAuthError() });

    await assert.rejects(
      () => sendVerificationEmail("user@example.com", "https://app.test/x"),
      (err: unknown) => {
        assert.ok(err instanceof EmailDeliveryError);
        assert.equal(err.code, "EMAIL_DELIVERY_FAILED");
        return true;
      },
    );
  });

  it("never puts Gmail's wording in the thrown message", async () => {
    fakeTransport({ fail: gmailAuthError() });

    await assert.rejects(
      () => sendVerificationEmail("user@example.com", "https://app.test/x"),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.ok(!message.includes("535"), "the SMTP response must not reach the caller");
        assert.ok(!message.includes("Username and Password"));
        return true;
      },
    );
  });
});

describe("smtpErrorDetails", () => {
  it("keeps the diagnostic fields", () => {
    const details = smtpErrorDetails(gmailAuthError());
    assert.equal(details.code, "EAUTH");
    assert.equal(details.responseCode, 535);
    assert.equal(details.command, "AUTH PLAIN");
  });

  it("is an allowlist, so an attached credential cannot be logged", () => {
    const err = gmailAuthError();
    err.auth = { user: "sender@example.com", pass: "abcdefghijklmnop" };
    err.envelope = { from: "sender@example.com" };

    const details = smtpErrorDetails(err);
    const serialized = JSON.stringify(details);

    assert.ok(!serialized.includes("abcdefghijklmnop"), "the password must never be logged");
    assert.equal("auth" in details, false);
    assert.equal("envelope" in details, false);
  });
});

describe("verifyEmailTransport", () => {
  it("reports true when the mail server accepts the configuration", async () => {
    fakeTransport({});
    assert.equal(await verifyEmailTransport(), true);
  });

  it("reports false — and does not throw — when the credentials are rejected", async () => {
    fakeTransport({ verifyFails: gmailAuthError() });
    // Must not throw: a bad app password is a broken feature, not a reason to
    // stop the API from serving public pages.
    assert.equal(await verifyEmailTransport(), false);
  });
});

/**
 * The ordering rule, exercised directly. These are the cases that decide
 * whether a user can be told "check your inbox".
 */
describe("token issue / send ordering", () => {
  type Recorded = { created: number; sent: number; discarded: string[]; marked: string[] };

  function recorder(): { calls: Recorded; deps: Parameters<typeof issueTokenThenSend>[0] } {
    const calls: Recorded = { created: 0, sent: 0, discarded: [], marked: [] };
    return {
      calls,
      deps: {
        createToken: async () => {
          calls.created += 1;
          return { id: "token-1" };
        },
        send: async () => {
          calls.sent += 1;
        },
        markSent: async (id) => {
          calls.marked.push(id);
        },
        discard: async (id) => {
          calls.discarded.push(id);
        },
      },
    };
  }

  it("marks the token sent only after a successful delivery", async () => {
    const { calls, deps } = recorder();

    await issueTokenThenSend(deps);

    assert.equal(calls.created, 1);
    assert.equal(calls.sent, 1);
    assert.deepEqual(calls.marked, ["token-1"]);
    assert.deepEqual(calls.discarded, []);
  });

  it("discards the token and rethrows when the send fails", async () => {
    const { calls, deps } = recorder();
    const failing = { ...deps, send: async () => { throw new EmailDeliveryError(); } };

    await assert.rejects(() => issueTokenThenSend(failing), EmailDeliveryError);

    // The token is gone, and it was NEVER marked usable.
    assert.deepEqual(calls.discarded, ["token-1"]);
    assert.deepEqual(calls.marked, []);
  });

  it("wraps a non-delivery failure so the route can still answer 502", async () => {
    const { deps } = recorder();
    const failing = {
      ...deps,
      send: async () => {
        throw new Error("socket hang up");
      },
      wrapError: (err: unknown) => new EmailDeliveryError("Unable to send", { cause: err }),
    };

    await assert.rejects(() => issueTokenThenSend(failing), EmailDeliveryError);
  });

  it("still refuses to mark the token sent when cleanup itself fails", async () => {
    const { calls, deps } = recorder();
    const failing = {
      ...deps,
      send: async () => {
        throw new EmailDeliveryError();
      },
      discard: async () => {
        throw new Error("database unavailable");
      },
    };

    await assert.rejects(() => issueTokenThenSend(failing), EmailDeliveryError);
    // The row may survive, but it is still `pending` — and only `sent` unlocks.
    assert.deepEqual(calls.marked, []);
  });
});
