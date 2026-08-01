import { NextResponse } from "next/server";

import { getRoomByCode, updateRoom } from "@/lib/duel-store";
import { isValidRoomCode, normaliseRoomCode } from "@/lib/room-code";
import { authoriseRoomRequest } from "@/lib/session";
import { getServerClient } from "@/lib/supabase-server";
import { advanceExpiredTurn } from "@/lib/turn-timer";

export const dynamic = "force-dynamic";

/**
 * World Cup years the wheel can land on. Must stay in sync with the seed
 * data in wc_players.
 */
const WC_YEARS = [1970,1974,1978,1982,1986,1990,1994,1998,2002,2006,2010,2014,2018,2022,2026];

/**
 * POST /api/duels/rooms/:code/roll
 *
 * Server-authoritative wheel roll for duel drafting. The old solo /api/roll
 * endpoint still exists for the single-player tournament, but duels go
 * through here so:
 *   1. The turn owner is authenticated (session token) and matched against
 *      current_turn on the room. A client can't roll during the opponent's turn.
 *   2. The result is persisted to duel_rooms so the OPPONENT can see what
 *      nation and year were drawn while it's not their turn.
 *
 * Body: { mode: "full" | "nation" | "year" }
 *   full   — full random, subject to soft "don't roll the same nation/year
 *            twice in a row" preference via previous roll.
 *   nation — keep the previous year, roll a new nation.
 *   year   — keep the previous nation, roll a new year.
 *
 * Response: { room, nationCode, nationName, year, squad }
 */
export async function POST(request, { params }) {
  const { code } = await params;
  const roomCode = normaliseRoomCode(code);

  if (!isValidRoomCode(roomCode)) {
    return NextResponse.json({ error: "Invalid room code" }, { status: 400 });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    /* body is optional; mode defaults to "full" */
  }
  const mode = body?.mode === "nation" || body?.mode === "year" ? body.mode : "full";

  const supabase = getServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  try {
    // Lazy timeout: if the caller has already blown their 90-second
    // window, skip their turn before they get to roll. Prevents a slow
    // drafter from rolling after their deadline and then picking against
    // the fresh nation/year.
    const room = await advanceExpiredTurn(await getRoomByCode(roomCode));
    if (!room) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 });
    }

    const auth = authoriseRoomRequest(request, room.id);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    const sender = auth.address;

    if (room.status !== "drafting") {
      return NextResponse.json(
        { error: `Cannot roll while the duel is '${room.status}'` },
        { status: 409 }
      );
    }
    if (room.current_turn !== sender) {
      return NextResponse.json(
        { error: "It is not your turn" },
        { status: 409 }
      );
    }

    // ── Resolve the roll's target (year, nation) ─────────────────────────
    const prevNation = room.current_roll_nation || null;
    const prevYear = room.current_roll_year ? Number(room.current_roll_year) : null;

    let year;
    let nationCode;
    let nationName;

    if (mode === "year" && prevNation) {
      // Keep the nation, pick a different year that has this nation.
      const years = await getYearsForNation(supabase, prevNation, prevYear);
      if (years.length === 0) {
        // Nation only appears in the previous year — fall back to full.
        ({ year, nationCode, nationName } = await rollFullRandom(supabase, prevNation, prevYear));
      } else {
        year = years[Math.floor(Math.random() * years.length)];
        const nation = await getNation(supabase, year, prevNation);
        nationCode = nation.nation_code;
        nationName = nation.nation_name;
      }
    } else if (mode === "nation" && prevYear != null) {
      // Keep the year, pick a different nation from that year.
      const nation = await pickRandomNation(supabase, prevYear, prevNation);
      if (!nation) {
        // Only one nation in that year; degrade gracefully to full random.
        ({ year, nationCode, nationName } = await rollFullRandom(supabase, prevNation, prevYear));
      } else {
        year = prevYear;
        nationCode = nation.nation_code;
        nationName = nation.nation_name;
      }
    } else {
      ({ year, nationCode, nationName } = await rollFullRandom(supabase, prevNation, prevYear));
    }

    const squad = await getSquad(supabase, year, nationCode);

    // ── Persist so the opponent can see what we drew ─────────────────────
    const updated = await updateRoom(room.id, {
      current_roll_nation: nationCode,
      current_roll_year: year,
      current_roll_at: new Date().toISOString(),
    });

    return NextResponse.json({
      room: updated,
      year,
      nationCode,
      nationName,
      squad: shuffle(squad),
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to roll", details: error.message },
      { status: 500 }
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// A cut-down copy of the solo /api/roll helpers so a duel roll never needs to
// leave this file. Kept local rather than shared: the solo endpoint takes
// query params from the client while this one derives its inputs from the
// server-owned room state.

async function rollFullRandom(supabase, excludeNation, excludeYear) {
  let years = [...WC_YEARS];
  if (excludeYear) years = years.filter((y) => y !== excludeYear);
  if (years.length === 0) years = [...WC_YEARS];

  const year = years[Math.floor(Math.random() * years.length)];
  const nation = await pickRandomNation(supabase, year, excludeNation);
  if (!nation) {
    // Every year has at least one nation, but exclude filters could zero it
    // out. Fall back to any nation from a random year.
    const anyYear = WC_YEARS[Math.floor(Math.random() * WC_YEARS.length)];
    const anyNation = await pickRandomNation(supabase, anyYear, null);
    if (!anyNation) throw new Error("No nations available");
    return {
      year: anyYear,
      nationCode: anyNation.nation_code,
      nationName: anyNation.nation_name,
    };
  }
  return {
    year,
    nationCode: nation.nation_code,
    nationName: nation.nation_name,
  };
}

async function pickRandomNation(supabase, year, excludeNation) {
  let query = supabase
    .from("wc_players")
    .select("nation_code, nation_name")
    .eq("year", year);
  if (excludeNation) query = query.neq("nation_code", excludeNation);

  const { data, error } = await query;
  if (error) throw error;
  if (!data || data.length === 0) return null;

  const seen = new Set();
  const nations = [];
  for (const row of data) {
    if (!seen.has(row.nation_code)) {
      seen.add(row.nation_code);
      nations.push({ nation_code: row.nation_code, nation_name: row.nation_name });
    }
  }
  if (nations.length === 0) return null;
  return nations[Math.floor(Math.random() * nations.length)];
}

async function getYearsForNation(supabase, nationCode, excludeYear) {
  let query = supabase.from("wc_players").select("year").eq("nation_code", nationCode);
  if (excludeYear) query = query.neq("year", excludeYear);
  const { data, error } = await query;
  if (error) throw error;
  return [...new Set((data || []).map((r) => r.year))];
}

async function getNation(supabase, year, nationCode) {
  const { data, error } = await supabase
    .from("wc_players")
    .select("nation_code, nation_name")
    .eq("year", year)
    .eq("nation_code", nationCode)
    .limit(1);
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error(`Nation ${nationCode} not found in ${year}`);
  }
  return data[0];
}

async function getSquad(supabase, year, nationCode) {
  const { data, error } = await supabase
    .from("wc_players")
    .select("id, name, jersey_number, rating, position, positions, attack, defense, is_legendary")
    .eq("year", year)
    .eq("nation_code", nationCode)
    .order("rating", { ascending: false });
  if (error) throw error;
  return (data || []).map((p) => ({
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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
