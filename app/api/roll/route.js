import { NextResponse } from "next/server";
import { getServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * Available World Cup years — must stay in sync with what's seeded in the DB.
 */
const WC_YEARS = [1970,1974,1978,1982,1986,1990,1994,1998,2002,2006,2010,2014,2018,2022,2026];

/**
 * GET /api/roll?lockYear=2002&excludeNation=ARG
 * GET /api/roll?lockNation=BRA&excludeYear=2002
 * GET /api/roll  (full random)
 *
 * Returns: { year, nationCode, nationName, squad[] }
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const lockYear = searchParams.get("lockYear") ? Number(searchParams.get("lockYear")) : null;
  const lockNation = searchParams.get("lockNation");
  const excludeNation = searchParams.get("excludeNation");
  const excludeYear = searchParams.get("excludeYear") ? Number(searchParams.get("excludeYear")) : null;

  const supabase = getServerClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "Database not configured" },
      { status: 503 }
    );
  }

  try {
    let year, nationCode, nationName;

    if (lockYear !== null) {
      // Keep year, pick a different nation
      year = lockYear;
      const nation = await pickRandomNation(supabase, year, excludeNation);
      if (!nation) {
        // Only one nation in this year — full random with excluded year
        return rollFullRandom(supabase, null, lockYear);
      }
      nationCode = nation.nation_code;
      nationName = nation.nation_name;

    } else if (lockNation) {
      // Keep nation, pick a different year
      const available = await getYearsForNation(supabase, lockNation, excludeYear);
      if (available.length === 0) {
        // Nation doesn't appear in any other year — full random
        return rollFullRandom(supabase, null, excludeYear);
      }
      year = available[Math.floor(Math.random() * available.length)];
      const nation = await getNation(supabase, year, lockNation);
      nationCode = nation.nation_code;
      nationName = nation.nation_name;

    } else {
      // Full random
      return rollFullRandom(supabase, excludeNation, excludeYear);
    }

    // Fetch the squad for this year + nation
    const squad = await getSquad(supabase, year, nationCode);

    return NextResponse.json({
      year,
      nationCode,
      nationName,
      squad: shuffle(squad),
    });

  } catch (error) {
    console.error("[/api/roll] Error:", error);
    return NextResponse.json(
      { error: "Failed to roll", details: error.message },
      { status: 500 }
    );
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function rollFullRandom(supabase, excludeNation, excludeYear) {
  // Pick a random year
  let years = [...WC_YEARS];
  if (excludeYear) years = years.filter(y => y !== excludeYear);
  const year = years[Math.floor(Math.random() * years.length)];

  // Pick a random nation from that year
  const nation = await pickRandomNation(supabase, year, excludeNation);
  if (!nation) {
    return NextResponse.json(
      { error: "No nations found for this year" },
      { status: 500 }
    );
  }

  const squad = await getSquad(supabase, year, nation.nation_code);

  return NextResponse.json({
    year,
    nationCode: nation.nation_code,
    nationName: nation.nation_name,
    squad: shuffle(squad),
  });
}

/**
 * Pick a random nation from a given year, optionally excluding one.
 */
async function pickRandomNation(supabase, year, excludeNation) {
  let query = supabase
    .from("wc_players")
    .select("nation_code, nation_name")
    .eq("year", year);

  if (excludeNation) {
    query = query.neq("nation_code", excludeNation);
  }

  const { data, error } = await query;
  if (error) throw error;
  if (!data || data.length === 0) return null;

  // Get distinct nations
  const nations = [];
  const seen = new Set();
  for (const row of data) {
    if (!seen.has(row.nation_code)) {
      seen.add(row.nation_code);
      nations.push({ nation_code: row.nation_code, nation_name: row.nation_name });
    }
  }

  if (nations.length === 0) return null;
  return nations[Math.floor(Math.random() * nations.length)];
}

/**
 * Get all years where a given nation has players.
 */
async function getYearsForNation(supabase, nationCode, excludeYear) {
  let query = supabase
    .from("wc_players")
    .select("year")
    .eq("nation_code", nationCode);

  if (excludeYear) {
    query = query.neq("year", excludeYear);
  }

  const { data, error } = await query;
  if (error) throw error;

  const years = [...new Set((data || []).map(r => r.year))];
  return years;
}

/**
 * Get nation info for a specific year + nation_code.
 */
async function getNation(supabase, year, nationCode) {
  const { data, error } = await supabase
    .from("wc_players")
    .select("nation_code, nation_name")
    .eq("year", year)
    .eq("nation_code", nationCode)
    .limit(1);

  if (error) throw error;
  if (!data || data.length === 0) throw new Error(`Nation ${nationCode} not found in ${year}`);
  return data[0];
}

/**
 * Fetch the full squad for a year + nation.
 */
async function getSquad(supabase, year, nationCode) {
  const { data, error } = await supabase
    .from("wc_players")
    .select("id, name, jersey_number, rating, position, positions, attack, defense, is_legendary")
    .eq("year", year)
    .eq("nation_code", nationCode)
    .order("rating", { ascending: false });

  if (error) throw error;

  // Map to the format the frontend expects
  return (data || []).map(p => ({
    id: p.id,
    name: p.name,
    jerseyNumber: p.jersey_number,
    rating: p.rating,
    position: p.position,
    positions: p.positions || [p.position],
    attack: p.attack,
    defense: p.defense,
    isLegendary: p.is_legendary,
    stats: { att: p.attack, def: p.defense },
  }));
}

/**
 * Fisher-Yates shuffle.
 */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
