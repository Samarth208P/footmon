import { NextResponse } from "next/server";

import {
  getRoomByCode,
  listMatchLogs,
  listSquads,
  listSquadSlots,
} from "@/lib/duel-store";
import { isValidRoomCode, normaliseRoomCode } from "@/lib/room-code";
import { getServerClient } from "@/lib/supabase-server";
import { advanceExpiredTurn } from "@/lib/turn-timer";

export const dynamic = "force-dynamic";

/**
 * GET /api/duels/rooms/:code
 *
 * Returns the room plus, once a draft is underway, both squads' current
 * pick slots so the client can render each player's growing team in real
 * time. Password hashes are never selected here.
 */
export async function GET(request, { params }) {
  const { code } = await params;
  const roomCode = normaliseRoomCode(code);

  if (!isValidRoomCode(roomCode)) {
    return NextResponse.json({ error: "Invalid room code" }, { status: 400 });
  }

  try {
    // Lazy timeout enforcement — whichever client polls next applies
    // the rating penalty and refreshes the drafter's deadline. The turn
    // stays with them so they can finish picking from the same list.
    const room = await advanceExpiredTurn(await getRoomByCode(roomCode));
    if (!room) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 });
    }

    // Once we're past the ready phase, always ship the picks so both clients
    // can stream the opponent's growing squad. Before that there are no picks
    // yet so we save a query.
    const includeSquads = ["drafting", "simulating", "complete"].includes(room.status);

    if (!includeSquads) {
      return NextResponse.json({ room });
    }

    // Run squad loading and current-roll fetch in parallel.
    const [squads, currentRoll] = await Promise.all([
      listSquads(room.id),
      (room.status === "drafting" && room.current_roll_nation && room.current_roll_year)
        ? loadCurrentRollSquad(room.current_roll_nation, Number(room.current_roll_year))
        : Promise.resolve(null),
    ]);

    const bySquad = await Promise.all(
      squads.map(async (s) => ({
        player: s.player,
        formation: s.formation,
        nation: s.nation,
        year: s.year,
        slots: await listSquadSlots(s.id),
      }))
    );

    await enrichSlotsWithJersey(bySquad);

    const { searchParams } = new URL(request.url);
    const withLogs = searchParams.get("state") === "1";
    const matchLogs = withLogs ? await listMatchLogs(room.id) : undefined;

    return NextResponse.json({
      room,
      squads: bySquad,
      ...(currentRoll ? { currentRoll } : {}),
      ...(matchLogs ? { matchLogs } : {}),
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to load room", details: error.message },
      { status: 500 }
    );
  }
}

/**
 * Enrich slot rows in-place with the shirt number from wc_players.
 *
 * One bulk query per response (up to ~22 rows across both squads). If the
 * table isn't reachable or a row can't be matched we simply leave
 * jersey_number as null and let the client fall back to the rating —
 * this is a display nicety, not a correctness requirement.
 */
async function enrichSlotsWithJersey(bySquad) {
  const supabase = getServerClient();
  if (!supabase) return;

  const needles = [];
  for (const sq of bySquad) {
    for (const slot of sq.slots || []) {
      if (slot.player_nation && slot.player_year && slot.player_name) {
        needles.push({
          name: slot.player_name,
          nation: slot.player_nation,
          year: slot.player_year,
          slot,
        });
      }
    }
  }
  if (needles.length === 0) return;

  const names = [...new Set(needles.map((n) => n.name))];
  const nations = [...new Set(needles.map((n) => n.nation))];
  const years = [...new Set(needles.map((n) => n.year))];

  try {
    const { data, error } = await supabase
      .from("wc_players")
      .select("name, nation_code, year, jersey_number, position, positions")
      .in("name", names)
      .in("nation_code", nations)
      .in("year", years);
    if (error || !data) return;

    // Bucket by exact (name|nation|year) triple. Duplicate (name, nation, year)
    // shouldn't exist in wc_players, but if it does we just take the first.
    const byKey = new Map();
    for (const row of data) {
      const key = `${row.name}|${row.nation_code}|${row.year}`;
      if (!byKey.has(key)) {
        const positions = Array.isArray(row.positions) && row.positions.length > 0
          ? row.positions
          : row.position
            ? [row.position]
            : [];
        byKey.set(key, { jersey: row.jersey_number, positions });
      }
    }

    for (const needle of needles) {
      const key = `${needle.name}|${needle.nation}|${needle.year}`;
      const info = byKey.get(key);
      if (info) {
        if (typeof info.jersey === "number" || typeof info.jersey === "string") {
          needle.slot.jersey_number = Number(info.jersey);
        }
        if (info.positions.length > 0) {
          needle.slot.player_positions = info.positions;
        }
      }
    }
  } catch {
    /* enrichment is best-effort */
  }
}

/**
 * Look up the full squad for a (nation, year) pair. Used so the opponent's
 * client can render the list of players the current drafter is choosing
 * from without needing its own roll endpoint or a shared seed.
 *
 * Returns null on any failure — the caller treats that as "no live roll".
 */
async function loadCurrentRollSquad(nationCode, year) {
  const supabase = getServerClient();
  if (!supabase) return null;
  try {
    const { data: nationRow } = await supabase
      .from("wc_players")
      .select("nation_code, nation_name")
      .eq("year", year)
      .eq("nation_code", nationCode)
      .limit(1);
    if (!nationRow || nationRow.length === 0) return null;

    const { data: squadRows } = await supabase
      .from("wc_players")
      .select("id, name, jersey_number, rating, position, positions, attack, defense, is_legendary")
      .eq("year", year)
      .eq("nation_code", nationCode)
      .order("rating", { ascending: false });

    return {
      nationCode,
      nationName: nationRow[0].nation_name,
      year,
      // Deterministic (rating-desc) order so both sides see the same list.
      // Shuffle only makes sense for the drafter's own private view.
      squad: (squadRows || []).map((p) => ({
        id: p.id,
        name: p.name,
        jerseyNumber: p.jersey_number,
        rating: p.rating,
        position: p.position,
        positions: p.positions || [p.position],
        attack: p.attack,
        defense: p.defense,
        isLegendary: p.is_legendary,
      })),
    };
  } catch {
    return null;
  }
}
