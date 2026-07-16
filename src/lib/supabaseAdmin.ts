import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

/**
 * Supabase admin client.
 *
 * Uses the service role key, which bypasses Row Level Security.
 * SERVER-SIDE ONLY — must never be imported by or shipped to the frontend.
 */
export const supabaseAdmin = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);
