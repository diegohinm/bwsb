import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guardrails against the two mistakes that exhaust a 15-slot pooler.
 *
 * These read the SOURCE rather than exercising behaviour, deliberately. Both
 * failures are invisible at runtime until production runs out of connections —
 * a second `PrismaClient` works perfectly on a developer's machine, and a job
 * that executes on import only hurts when something imports it. A review can
 * miss either; a test cannot.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "generated") continue;
      sourceFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const files = sourceFiles(SRC).map((f) => ({
  path: relative(SRC, f).replace(/\\/g, "/"),
  text: readFileSync(f, "utf8"),
}));

describe("a single connection pool per process", () => {
  it("constructs PrismaClient in exactly one place", () => {
    const constructors = files
      .filter((f) => /new PrismaClient\s*\(/.test(f.text))
      .map((f) => f.path);

    assert.deepEqual(
      constructors,
      ["lib/prisma.ts"],
      "every other module must import the shared client — a second one opens a second pool",
    );
  });

  it("has no module importing PrismaClient for construction elsewhere", () => {
    const importers = files
      .filter((f) => f.path !== "lib/prisma.ts")
      .filter((f) => /import\s*\{[^}]*\bPrismaClient\b[^}]*\}\s*from\s*"@prisma\/client"/.test(f.text))
      .map((f) => f.path);

    assert.deepEqual(importers, [], "PrismaClient is only needed where it is constructed");
  });
});

describe("disconnect only at shutdown", () => {
  it("calls $disconnect nowhere but the shared helper", () => {
    const callers = files
      .filter((f) => f.path !== "lib/prisma.ts" && !f.path.includes("__tests__"))
      .filter((f) => /\$disconnect\s*\(/.test(f.text))
      .map((f) => f.path);

    // Long-running services must never close the pool; standalone scripts go
    // through `disconnectPrisma()`, which is idempotent and logs.
    assert.deepEqual(
      callers,
      [],
      "use disconnectPrisma() from lib/prisma.ts instead of calling $disconnect directly",
    );
  });
});

describe("the pg session pool", () => {
  it("caps itself explicitly", () => {
    // `connection_limit` in DATABASE_URL is a PRISMA parameter. The pg driver
    // ignores it and defaults to ten connections, which made this pool the
    // largest single consumer of a 15-slot pooler.
    const store = files.find((f) => f.path === "lib/sessionStore.ts");
    assert.ok(store, "lib/sessionStore.ts not found");
    assert.match(store.text, /max:\s*SESSION_POOL_MAX/, "the pool must set an explicit max");
    assert.match(store.text, /idleTimeoutMillis/, "idle sessions must be released");
  });

  it("is closed during shutdown", () => {
    const server = files.find((f) => f.path === "server.ts");
    assert.ok(server?.text.includes("closeSessionPool()"), "the pool outlives Prisma otherwise");
  });

  it("is the only pg Pool in the codebase", () => {
    const pools = files
      .filter((f) => !f.path.includes("__tests__"))
      .filter((f) => /new Pool\s*\(/.test(f.text))
      .map((f) => f.path);
    assert.deepEqual(pools, ["lib/sessionStore.ts"]);
  });
});

describe("no work at import time", () => {
  it("guards every standalone entrypoint behind isMainModule", () => {
    // `void main()` at module scope runs the job — and, in three files here,
    // closed the shared pool — the moment anything imported the module.
    const offenders = files
      .filter((f) => !f.path.includes("__tests__"))
      .filter((f) => /^\s*(void\s+)?main\s*\(\s*\)/m.test(f.text))
      .filter((f) => !f.text.includes("isMainModule(import.meta.url)"))
      .map((f) => f.path);

    assert.deepEqual(
      offenders,
      [],
      "wrap the entrypoint in `if (isMainModule(import.meta.url))`",
    );
  });

  it("starts no timer at module scope", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f.path.includes("__tests__")) continue;
      for (const line of f.text.split("\n")) {
        // A timer at column 0 is running as a side effect of the import; one
        // inside a function body is indented and is started deliberately.
        if (/^(const\s+\w+\s*=\s*)?setInterval\s*\(/.test(line)) offenders.push(f.path);
      }
    }
    assert.deepEqual(offenders, [], "expose start/stop functions instead of a top-level timer");
  });
});
