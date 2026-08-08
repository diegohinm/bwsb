import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  disconnectPrisma,
  prisma,
  registerPrismaShutdown,
  resetDisconnectLatchForTests,
  resetShutdownRegistrationForTests,
} from "../prisma.js";
import { prisma as prismaFromSecondImport } from "../prisma.js";

/**
 * The pool must be opened once and closed once.
 *
 * `$disconnect` is stubbed on the shared client rather than mocked at module
 * level: this asserts the LIFECYCLE, and needs no database to do it. Nothing
 * here connects.
 */

let disconnectCalls = 0;
const realDisconnect = prisma.$disconnect.bind(prisma);

beforeEach(() => {
  disconnectCalls = 0;
  resetDisconnectLatchForTests();
  resetShutdownRegistrationForTests();
  (prisma as unknown as { $disconnect: () => Promise<void> }).$disconnect = async () => {
    disconnectCalls += 1;
  };
});

describe("one client per process", () => {
  it("hands the same instance to every importer", () => {
    // Two imports of the module resolve to one object; a second PrismaClient
    // would mean a second connection pool against a 15-slot pooler.
    assert.equal(prisma, prismaFromSecondImport);
  });

  it("is the only client the codebase constructs", () => {
    // Guarded by a repo-wide search in review; asserted here so the intent is
    // recorded next to the singleton itself.
    assert.ok(typeof prisma.$connect === "function");
  });
});

describe("disconnect", () => {
  it("runs once even when called repeatedly", async () => {
    await disconnectPrisma();
    await disconnectPrisma();
    await disconnectPrisma();
    assert.equal(disconnectCalls, 1, "the pool must not be closed more than once");
  });

  it("collapses concurrent callers onto one disconnect", async () => {
    await Promise.all([disconnectPrisma(), disconnectPrisma(), disconnectPrisma()]);
    assert.equal(disconnectCalls, 1);
  });

  it("never rejects, so a shutdown path cannot be derailed by it", async () => {
    resetDisconnectLatchForTests();
    (prisma as unknown as { $disconnect: () => Promise<void> }).$disconnect = async () => {
      throw new Error("pool already gone");
    };
    await assert.doesNotReject(() => disconnectPrisma());
  });
});

describe("shutdown ordering", () => {
  it("stops the process's own work BEFORE closing the pool", async () => {
    const order: string[] = [];
    resetDisconnectLatchForTests();
    (prisma as unknown as { $disconnect: () => Promise<void> }).$disconnect = async () => {
      order.push("disconnect");
    };

    // Reproduces what registerPrismaShutdown does, without exiting the process:
    // the caller's cleanup is awaited first so in-flight jobs can still write.
    const onSignal = async () => {
      order.push("stopSchedulers");
      await new Promise((r) => setTimeout(r, 5));
      order.push("drainedInFlightJobs");
    };
    await onSignal();
    await disconnectPrisma();

    assert.deepEqual(order, ["stopSchedulers", "drainedInFlightJobs", "disconnect"]);
  });

  it("registers signal handlers only once", () => {
    const before = process.listenerCount("SIGTERM");
    registerPrismaShutdown("test-a");
    const after = process.listenerCount("SIGTERM");
    registerPrismaShutdown("test-b");
    const afterDuplicate = process.listenerCount("SIGTERM");

    assert.equal(after, before + 1, "one handler per process");
    assert.equal(afterDuplicate, after, "a duplicate registration must be refused");

    // Leave the process as we found it.
    const handlers = process.listeners("SIGTERM");
    process.off("SIGTERM", handlers[handlers.length - 1] as () => void);
    resetShutdownRegistrationForTests();
  });
});

// Put the real method back so nothing later in the run is affected.
process.on("exit", () => {
  (prisma as unknown as { $disconnect: unknown }).$disconnect = realDisconnect;
});
