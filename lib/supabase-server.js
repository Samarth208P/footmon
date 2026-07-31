import { createClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client.
 *
 * Uses the SECRET (service role) key, which bypasses RLS. This is what makes
 * draft turns and match results authoritative: the browser only ever holds the
 * publishable key and has SELECT-only access, so it cannot forge a pick or a
 * scoreline by writing to Postgres directly.
 *
 * Never import this from client-side code.
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";

// Accepts either a modern `sb_secret_...` key or a legacy service_role JWT.
const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";

let client = null;
let missingConfigAnnounced = false;

/** True when a real Supabase connection is configured. */
export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
}

/**
 * Guards against the classic footgun of pasting a publishable key into the
 * secret slot. A publishable key is RLS-constrained, so every server write
 * would silently fail and the app would fall back to memory.
 */
export function assertNotPublishableKey() {
  if (SUPABASE_SECRET_KEY.startsWith("sb_publishable_")) {
    throw new Error(
      "[FootMon] SUPABASE_SERVICE_ROLE_KEY holds a PUBLISHABLE key " +
        "(sb_publishable_...). That key is RLS-constrained and cannot perform " +
        "server-authoritative writes. Use the project's secret key " +
        "(sb_secret_... or the legacy service_role JWT)."
    );
  }
}

/**
 * @returns {import("@supabase/supabase-js").SupabaseClient|null}
 *          null when unconfigured, so callers can degrade to memory.
 */
export function getServerClient() {
  if (!isSupabaseConfigured()) {
    if (!missingConfigAnnounced) {
      missingConfigAnnounced = true;
      console.error(
        "\n" +
          "==============================================================\n" +
          " FootMon: SUPABASE IS NOT CONFIGURED - USING IN-MEMORY STORE\n" +
          "--------------------------------------------------------------\n" +
          " Duel state will NOT survive a server restart and will NOT be\n" +
          " shared across devices or serverless instances.\n" +
          "\n" +
          " Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.\n" +
          "==============================================================\n"
      );
    }
    return null;
  }

  assertNotPublishableKey();

  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "X-Client-Info": "footmon-server" } },
    });
  }
  return client;
}

export const supabaseUrl = SUPABASE_URL;
