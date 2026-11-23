import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

/**
 * Supabase admin client.
 *
 * Uses the service role key, which bypasses Row Level Security.
 * SERVER-SIDE ONLY — must never be imported by or shipped to the frontend.
 *
 * Created on first use, not at import: a module that merely imports the storage
 * service (avatar validation, say) must not need Supabase credentials. The API
 * still refuses to start without them — see config/requireConnectionEnv.ts.
 * One instance per process, like the Prisma client.
 */
let client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  client ??= createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return client;
}
