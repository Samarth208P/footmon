/**
 * Wipes match / result state from Supabase while preserving:
 *   - wc_players  (player nation/year/rating database)
 *   - profiles    (claimed usernames)
 *
 * Uses the service-role key to bypass RLS. Order matters where foreign
 * keys are present — children before parents.
 *
 * Run once:
 *   node --env-file=.env scripts/reset-supabase-match-data.mjs
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY must be set");
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

// Ordered children → parents so FKs are respected.
const TABLES = [
  "match_logs",
  "duel_squad_slots",
  "duel_squads",
  "duel_room_secrets",
  "duel_events",
  "duel_rooms",
  "duel_challenges",       // legacy — may not exist in prod
  "duel_leaderboard",
  "tournament_leaderboard",
];

// A neutral WHERE clause that matches every row of every schema in this
// project — the supabase-js `.delete()` builder requires a filter, and
// each of these tables has at least one always-truthy comparison
// against a real column.
const NEUTRAL_FILTER = {
  match_logs:              { col: "id",        val: -1n },
  duel_squad_slots:        { col: "id",        val: -1n },
  duel_squads:             { col: "id",        val: -1n },
  duel_room_secrets:       { col: "room_id",   val: "00000000-0000-0000-0000-000000000000" },
  duel_events:             { col: "id",        val: -1n },
  duel_rooms:              { col: "id",        val: "00000000-0000-0000-0000-000000000000" },
  duel_challenges:         { col: "duel_id",   val: "\u0000" },
  duel_leaderboard:        { col: "address",   val: "0x0000000000000000000000000000000000000000" },
  tournament_leaderboard:  { col: "id",        val: -1n },
};

async function tableExists(name) {
  // Cheap check: HEAD count with the same filter shape.
  const filter = NEUTRAL_FILTER[name];
  const { error } = await supabase
    .from(name)
    .select(filter.col, { count: "exact", head: true });
  if (error) {
    // 42P01 = undefined_table (Postgres error code)
    if (error.code === "42P01" || /does not exist/i.test(error.message)) return false;
    // Some other error — surface it so we don't silently skip.
    throw new Error(`tableExists(${name}) probe failed: ${error.message}`);
  }
  return true;
}

async function wipe(name) {
  const filter = NEUTRAL_FILTER[name];
  const before = await supabase
    .from(name)
    .select(filter.col, { count: "exact", head: true });
  const beforeCount = before.count ?? "?";

  const { error } = await supabase
    .from(name)
    .delete()
    .neq(filter.col, filter.val);

  if (error) {
    console.error(`  ✗ ${name}: ${error.message}`);
    return { ok: false, table: name, error: error.message };
  }

  const after = await supabase
    .from(name)
    .select(filter.col, { count: "exact", head: true });
  const afterCount = after.count ?? "?";

  console.log(`  ✓ ${name.padEnd(24)} ${String(beforeCount).padStart(6)} → ${afterCount}`);
  return { ok: true, table: name, before: beforeCount, after: afterCount };
}

console.log(`Connecting to ${url}`);
console.log("Tables to reset:");

const results = [];
for (const t of TABLES) {
  const exists = await tableExists(t);
  if (!exists) {
    console.log(`  · ${t.padEnd(24)} (does not exist, skipped)`);
    results.push({ ok: true, table: t, skipped: true });
    continue;
  }
  results.push(await wipe(t));
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} table(s) failed to clear.`);
  process.exit(1);
}

// Sanity: confirm preserved tables are untouched.
console.log("\nPreserved (untouched):");
for (const t of ["wc_players", "profiles"]) {
  const filter = { wc_players: "id", profiles: "address" }[t];
  const { count } = await supabase.from(t).select(filter, { count: "exact", head: true });
  console.log(`  · ${t.padEnd(24)} ${count} rows`);
}

console.log("\nDone.");
