import { assertConnectionEnv } from "./env.js";

/**
 * Side-effect import for process ENTRYPOINTS (src/server.ts, src/worker.ts):
 * exits unless DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are all
 * set, in every environment — the same fail-fast startup these processes have
 * always had.
 *
 * It must be the entrypoint's FIRST import. ES modules evaluate their imports
 * in order, and some dependencies read a connection setting while they load
 * (lib/sessionStore.ts builds its pg pool at import); this has to run before
 * they do, so a missing variable is one clear line instead of a stack trace.
 *
 * NEVER import this from a library module. The point of deferring the check in
 * config/env.ts is that importing library code — under unit test, typically —
 * works without credentials.
 */
assertConnectionEnv(process.env.SERVICE_ROLE ?? "startup");
