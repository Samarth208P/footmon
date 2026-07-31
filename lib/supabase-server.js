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

/** True when the secret slot mistakenly holds an RLS-constrained key. */
export function isPublishableKeyInSecretSlot() {
  return SUPABASE_SECRET_KEY.startsWith("sb_publishable_");
}

let publishableKeyAnnounced = false;

/**
 * Warns about the classic footgun of pasting a publishable key into the secret
 * slot.
 *
 * Deliberately does NOT throw. A publishable key still has SELECT, so reads
 * (profiles, lobby, leaderboards) work fine — taking the entire app down over a
 * misconfiguration that only affects writes turns a degraded deploy into a total
 * outage. Writes get a precise, actionable error instead; see unwrap() in
 * lib/duel-store.js.
 */
export function warnIfPublishableKey() {
  if (!isPublishableKeyInSecretSlot()) return false;

  if (!publishableKeyAnnounced) {
    publishableKeyAnnounced = true;
    console.error(
      "\n" +
        "==============================================================\n" +
        " FootMon: SUPABASE_SERVICE_ROLE_KEY HOLDS A PUBLISHABLE KEY\n" +
        "--------------------------------------------------------------\n" +
        " Reads will work. Every WRITE will be rejected by RLS:\n" +
        " no usernames, no rooms, no picks, no match results.\n" +
        "\n" +
        " Set it to the project's SECRET key (sb_secret_...) or the\n" +
        " legacy service_role JWT, then redeploy.\n" +
        "==============================================================\n"
    );
  }
  return true;
}

/** Message surfaced to callers when a write is attempted with the wrong key. */
export const PUBLISHABLE_KEY_WRITE_ERROR =
  "Server is misconfigured: SUPABASE_SERVICE_ROLE_KEY holds a publishable " +
  "(RLS-constrained) key, so this write was rejected. Set the project's secret " +
  "key on the server and redeploy.";

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

  warnIfPublishableKey();

  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "X-Client-Info": "footmon-server" } },
    });
  }
  return client;
}

export const supabaseUrl = SUPABASE_URL;
