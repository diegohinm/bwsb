import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

/**
 * The SMTP configuration is where the `535-5.7.8 Username and Password not
 * accepted` came from, so it is tested at the level the failure happened:
 *
 *   - a Google app password pasted as "abcd efgh ijkl mnop" is 19 characters
 *     and Gmail rejects it. The 16 characters are the password.
 *   - port 465 is implicit TLS and needs secure:true; 587 is STARTTLS and needs
 *     secure:false. The two are not independent settings.
 *   - an operator who sets SMTP_PASSWORD or SMTP_FROM must not be ignored
 *     because the code reads SMTP_PASS and EMAIL_FROM.
 *
 * env.ts parses process.env at import time, so each case re-imports the module
 * graph with a cache-busting query rather than trying to mutate a frozen object.
 */

const BASE_ENV = { ...process.env };

/** Load a fresh config module with `overrides` applied to process.env. */
async function loadSmtp(overrides: Record<string, string | undefined>) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SMTP_") || key === "EMAIL_FROM" || key === "DEV_EMAIL_MODE") {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const suffix = `?t=${Math.random().toString(36).slice(2)}`;
  return (await import(`../smtp.js${suffix}`)) as typeof import("../smtp.js");
}

beforeEach(() => {
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in BASE_ENV)) delete process.env[key];
  }
  Object.assign(process.env, BASE_ENV);
});

describe("app password normalization", () => {
  it("strips the spaces Google prints inside an app password", async () => {
    const smtp = await loadSmtp({
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "465",
      SMTP_USER: "someone@example.com",
      // Exactly how Google displays it.
      SMTP_PASSWORD: "abcd efgh ijkl mnop",
    });

    const config = smtp.getSmtpConfig();
    assert.equal(config.password, "abcdefghijklmnop");
    assert.equal(config.password.length, 16, "a Google app password is 16 characters");
  });

  it("reports the stripped length, which is how a bad paste is spotted", async () => {
    const smtp = await loadSmtp({
      SMTP_USER: "someone@example.com",
      SMTP_PASSWORD: "abcd efgh ijkl mnop",
    });
    const described = smtp.describeSmtp();
    assert.equal(described.passwordLength, 16);
    assert.equal(described.passwordConfigured, true);
  });

  it("accepts SMTP_PASS as well as SMTP_PASSWORD", async () => {
    const smtp = await loadSmtp({
      SMTP_USER: "someone@example.com",
      SMTP_PASS: "abcd efgh ijkl mnop",
    });
    assert.equal(smtp.getSmtpConfig().password, "abcdefghijklmnop");
  });

  it("prefers SMTP_PASSWORD when both are present", async () => {
    const smtp = await loadSmtp({
      SMTP_USER: "someone@example.com",
      SMTP_PASSWORD: "newpassword12345",
      SMTP_PASS: "oldpassword12345",
    });
    assert.equal(smtp.getSmtpConfig().password, "newpassword12345");
  });
});

describe("port and secure pairing", () => {
  it("uses implicit TLS on 465", async () => {
    const smtp = await loadSmtp({
      SMTP_PORT: "465",
      SMTP_USER: "u@example.com",
      SMTP_PASSWORD: "pass",
    });
    const config = smtp.getSmtpConfig();
    assert.equal(config.port, 465);
    assert.equal(config.secure, true);
  });

  it("uses STARTTLS on 587", async () => {
    const smtp = await loadSmtp({
      SMTP_PORT: "587",
      SMTP_USER: "u@example.com",
      SMTP_PASSWORD: "pass",
    });
    const config = smtp.getSmtpConfig();
    assert.equal(config.port, 587);
    assert.equal(config.secure, false);
  });

  it("defaults to Gmail's 465 + secure when nothing is set", async () => {
    const smtp = await loadSmtp({ SMTP_USER: "u@example.com", SMTP_PASSWORD: "pass" });
    const config = smtp.getSmtpConfig();
    assert.equal(config.host, "smtp.gmail.com");
    assert.equal(config.port, 465);
    assert.equal(config.secure, true);
  });

  it("lets an explicit SMTP_SECURE override the port default", async () => {
    const smtp = await loadSmtp({
      SMTP_PORT: "465",
      SMTP_SECURE: "false",
      SMTP_USER: "u@example.com",
      SMTP_PASSWORD: "pass",
    });
    assert.equal(smtp.getSmtpConfig().secure, false);
  });

  it("rejects a port that is not a valid TCP port", async () => {
    const smtp = await loadSmtp({
      SMTP_PORT: "not-a-port",
      SMTP_USER: "u@example.com",
      SMTP_PASSWORD: "pass",
    });
    assert.throws(() => smtp.getSmtpConfig(), /SMTP_PORT must be a valid TCP port/);
    // describeSmtp must still work — it is what the operator reads to find out why.
    assert.match(String(smtp.describeSmtp().error), /SMTP_PORT/);
  });
});

describe("configuration validation", () => {
  it("names the missing variable instead of failing later at AUTH", async () => {
    const smtp = await loadSmtp({ SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "465" });
    assert.throws(
      () => smtp.getSmtpConfig(),
      /SMTP configuration is incomplete\..*SMTP_USER and SMTP_PASSWORD are required/s,
    );
  });

  it("requires credentials, not just a host and port, to count as configured", async () => {
    const withoutCreds = await loadSmtp({ SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "465" });
    assert.equal(withoutCreds.isSmtpConfigured(), false);

    const withCreds = await loadSmtp({
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "465",
      SMTP_USER: "u@example.com",
      SMTP_PASSWORD: "pass",
    });
    assert.equal(withCreds.isSmtpConfigured(), true);
  });
});

describe("sender address", () => {
  it("uses SMTP_FROM when set", async () => {
    const smtp = await loadSmtp({
      SMTP_USER: "u@example.com",
      SMTP_PASSWORD: "pass",
      SMTP_FROM: "Support <support@example.com>",
    });
    assert.equal(smtp.getSmtpConfig().from, "Support <support@example.com>");
  });

  it("accepts EMAIL_FROM as the older name", async () => {
    const smtp = await loadSmtp({
      SMTP_USER: "u@example.com",
      SMTP_PASSWORD: "pass",
      EMAIL_FROM: "Legacy <legacy@example.com>",
    });
    assert.equal(smtp.getSmtpConfig().from, "Legacy <legacy@example.com>");
  });

  it("falls back to the authenticated user", async () => {
    const smtp = await loadSmtp({ SMTP_USER: "u@example.com", SMTP_PASSWORD: "pass" });
    assert.equal(smtp.getSmtpConfig().from, "u@example.com");
  });
});

describe("safe logging", () => {
  it("never includes the password in the described configuration", async () => {
    const secret = "supersecretpassword";
    const smtp = await loadSmtp({
      SMTP_USER: "u@example.com",
      SMTP_PASSWORD: secret,
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "465",
    });

    const described = smtp.describeSmtp();
    const serialized = JSON.stringify(described);
    assert.ok(!serialized.includes(secret), "describeSmtp must not leak the password");
    // But it must say enough to diagnose.
    assert.equal(described.host, "smtp.gmail.com");
    assert.equal(described.port, 465);
    assert.equal(described.secure, true);
    assert.equal(described.passwordConfigured, true);
    assert.equal(described.passwordLength, secret.length);
  });
});
