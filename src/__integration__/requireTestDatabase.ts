import { testDatabaseRefusals } from "./testDatabaseGuard.js";

/**
 * Side-effect guard: MUST be the first import of every integration test file
 * (and of fixtures.ts, so nothing that writes can be reached without it).
 *
 * ES modules evaluate their imports in order, so this runs before lib/prisma.ts
 * or config/env.ts load — and therefore before either of them (dotenv, or
 * Prisma's own loader) can fill an unset variable from a .env file. What it
 * sees is the real process environment and nothing else.
 *
 * On refusal it throws: node:test reports the file as failed, and no test in it
 * reaches a database.
 */
const refusals = testDatabaseRefusals(process.env);

if (refusals.length > 0) {
  throw new Error(
    "Refusing to run the integration suite:\n" +
      refusals.map((reason) => `  - ${reason}`).join("\n") +
      "\nIt only runs against the dedicated Supabase TEST project. See prisma/README.md → CI integration tests.",
  );
}
