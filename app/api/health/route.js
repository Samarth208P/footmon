import { NextResponse } from "next/server";

import { describeConfig, getServerClient } from "@/lib/supabase-server";
import { isChainConfigured, isResolverConfigured } from "@/lib/chain";
import { isSessionSecretConfigured } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * Diagnoses server wiring without leaking anything sensitive: it reports key
 * *class* and project *refs* (which are already public in the browser bundle),
 * never key material.
 *
 * Exists because the two failure modes that took the app down were both
 * invisible from the outside: a publishable key in the secret slot, and
 * SUPABASE_URL pointing at a different project than migrations were run against.
 */
const REQUIRED_TABLES = [
  "profiles",
  "duel_rooms",
  "duel_room_secrets",
  "duel_squads",
  "duel_squad_slots",
  "match_logs",
  "duel_leaderboard",
  "tournament_leaderboard",
];

export async function GET() {
  const config = describeConfig();

  const checks = {
    supabaseConfigured: config.supabaseConfigured,
    serviceKeyClass: config.serviceKeyClass,
    serverProjectRef: config.serverProjectRef,
    browserProjectRef: config.browserProjectRef,
    projectsMatch: config.projectsMatch,
    sessionSecret: isSessionSecretConfigured(),
    contractAddress: isChainConfigured(),
    resolverKey: isResolverConfigured(),
    tables: {},
  };

  const problems = [];

  if (!config.supabaseConfigured) {
    problems.push("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not both set.");
  }
  if (config.serviceKeyClass.startsWith("publishable")) {
    problems.push(
      "SUPABASE_SERVICE_ROLE_KEY holds a publishable key. Reads work, every write fails. " +
        "Use the project's secret key (sb_secret_...)."
    );
  }
  if (config.serverProjectRef && config.browserProjectRef && !config.projectsMatch) {
    problems.push(
      `SUPABASE_URL points at project '${config.serverProjectRef}' but ` +
        `NEXT_PUBLIC_SUPABASE_URL points at '${config.browserProjectRef}'. ` +
        "They must be the same project."
    );
  }
  if (!checks.sessionSecret) {
    problems.push("SESSION_SECRET is missing or shorter than 32 characters — duels cannot start.");
  }
  if (!checks.contractAddress) {
    problems.push("NEXT_PUBLIC_CONTRACT_ADDRESS is not a valid address — escrow is unavailable.");
  }
  if (!checks.resolverKey) {
    problems.push("RESOLVER_PRIVATE_KEY is missing — duels cannot be settled on-chain.");
  }

  // Probe each table so a missing migration is obvious rather than inferred.
  const client = getServerClient();
  if (client) {
    await Promise.all(
      REQUIRED_TABLES.map(async (table) => {
        const { error } = await client.from(table).select("*", { head: true, count: "exact" }).limit(1);
        checks.tables[table] = error ? (error.code || "error") : "ok";
      })
    );

    const missing = Object.entries(checks.tables)
      .filter(([, v]) => v !== "ok")
      .map(([k]) => k);

    if (missing.length > 0) {
      problems.push(
        `Missing or unreadable tables: ${missing.join(", ")}. ` +
          `Run \`npm run db:push\` against project '${config.serverProjectRef}'.`
      );
    }
  }

  const healthy = problems.length === 0;
  return NextResponse.json({ healthy, problems, checks }, { status: healthy ? 200 : 503 });
}
