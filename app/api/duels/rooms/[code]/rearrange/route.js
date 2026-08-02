import { NextResponse } from "next/server";

import {
  getRoomByCode,
  getSquad,
  listSquadSlots,
  rearrangeSquadSlots,
} from "@/lib/duel-store";
import { isValidRoomCode, normaliseRoomCode } from "@/lib/room-code";
import { authoriseRoomRequest } from "@/lib/session";
import {
  canFillSlot,
  DUEL_FORMATION,
  isValidSlotIndex,
  slotPositionFor,
} from "@/lib/draft";
import { getServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/duels/rooms/:code/rearrange
 *
 * Move or swap two slots inside the caller's own squad. Legal at any point
 * during the draft, whether it's the caller's turn or their opponent's —
 * this is purely a cosmetic/tactical reshuffle of players the caller has
 * already committed to.
 *
 * Body: { fromSlot: number, toSlot: number }
 * Auth: Bearer duel session token
 *
 * Rules:
 *   * Both indices are 0..10 and different.
 *   * The source slot must be filled (otherwise there's nothing to move).
 *   * If the destination slot is also filled, the swap is only legal when
 *     BOTH players can still fill the other's new formation position.
 *   * Position eligibility is looked up on wc_players (positions column)
 *     using (player_name, player_nation, player_year) — the stored
 *     player_position on the slot row is only the primary role and would
 *     otherwise disallow legitimate swaps.
 */
export async function POST(request, { params }) {
  const { code } = await params;
  const roomCode = normaliseRoomCode(code);

  if (!isValidRoomCode(roomCode)) {
    return NextResponse.json({ error: "Invalid room code" }, { status: 400 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const fromSlot = Number(body?.fromSlot);
  const toSlot = Number(body?.toSlot);
  if (!isValidSlotIndex(fromSlot) || !isValidSlotIndex(toSlot)) {
    return NextResponse.json({ error: "Invalid slot" }, { status: 400 });
  }
  if (fromSlot === toSlot) {
    return NextResponse.json({ error: "Nothing to rearrange" }, { status: 400 });
  }

  try {
    const room = await getRoomByCode(roomCode);
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
        { error: `Cannot rearrange while the duel is '${room.status}'` },
        { status: 409 }
      );
    }
    if (room.creator !== sender && room.joiner !== sender) {
      return NextResponse.json(
        { error: "You are not a participant in this duel" },
        { status: 403 }
      );
    }

    const squad = await getSquad(room.id, sender);
    if (!squad) {
      return NextResponse.json({ error: "Squad not initialised" }, { status: 409 });
    }

    const myFormation = squad.formation || DUEL_FORMATION;
    const slots = await listSquadSlots(squad.id);
    const fromRow = slots.find((s) => s.slot_index === fromSlot) || null;
    const toRow = slots.find((s) => s.slot_index === toSlot) || null;

    if (!fromRow) {
      return NextResponse.json(
        { error: "Nothing to move from that slot" },
        { status: 400 }
      );
    }

    const fromPos = slotPositionFor(fromSlot, myFormation);
    const toPos = slotPositionFor(toSlot, myFormation);

    // Fast path: skip wc_players lookup if primary positions already work.
    const fromPrimaryFits = canFillSlot(toSlot, [fromRow.player_position], myFormation);
    const toPrimaryFits = !toRow || canFillSlot(fromSlot, [toRow.player_position], myFormation);

    let fromPositions;
    let toPositions;

    if (fromPrimaryFits && toPrimaryFits) {
      fromPositions = [fromRow.player_position];
      toPositions = toRow ? [toRow.player_position] : null;
    } else {
      const positionsMap = await loadPositions(
        [fromRow, toRow].filter(Boolean).map((r) => ({
          name: r.player_name,
          nation: r.player_nation,
          year: r.player_year,
        }))
      );
      fromPositions = pickPositions(positionsMap, fromRow) || [fromRow.player_position];
      toPositions = toRow ? (pickPositions(positionsMap, toRow) || [toRow.player_position]) : null;
    }

    if (!canFillSlot(toSlot, fromPositions, myFormation)) {
      return NextResponse.json(
        { error: `${fromRow.player_name} can't play ${toPos}` },
        { status: 400 }
      );
    }

    if (toRow && toPositions && !canFillSlot(fromSlot, toPositions, myFormation)) {
      return NextResponse.json(
        { error: `${toRow.player_name} can't play ${fromPos}` },
        { status: 400 }
      );
    }

    await rearrangeSquadSlots({
      squadId: squad.id,
      fromRow,
      toRow,
      fromIndex: fromSlot,
      toIndex: toSlot,
      fromSlotPos: fromPos,
      toSlotPos: toPos,
    });

    // Return the freshly ordered squad so the caller can hydrate without
    // waiting for the next poll tick.
    const updatedSlots = await listSquadSlots(squad.id);
    return NextResponse.json({
      slots: updatedSlots,
      fromSlot,
      toSlot,
      swapped: Boolean(toRow),
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to rearrange", details: error.message },
      { status: 500 }
    );
  }
}

// ── Position lookups ────────────────────────────────────────────────────────

/**
 * Bulk lookup of wc_players.positions for a list of (name, nation, year)
 * triples. Returned as a Map keyed by "name|nation|year" so callers can
 * pull each player's positions list in O(1).
 */
async function loadPositions(needles) {
  const map = new Map();
  const supabase = getServerClient();
  if (!supabase || needles.length === 0) return map;

  const names = [...new Set(needles.map((n) => n.name).filter(Boolean))];
  const nations = [...new Set(needles.map((n) => n.nation).filter(Boolean))];
  const years = [...new Set(needles.map((n) => n.year).filter(Boolean))];

  if (names.length === 0 || nations.length === 0 || years.length === 0) return map;

  const { data, error } = await supabase
    .from("wc_players")
    .select("name, nation_code, year, position, positions")
    .in("name", names)
    .in("nation_code", nations)
    .in("year", years);
  if (error || !data) return map;

  for (const row of data) {
    const key = `${row.name}|${row.nation_code}|${row.year}`;
    const positions = Array.isArray(row.positions) && row.positions.length > 0
      ? row.positions
      : row.position
        ? [row.position]
        : [];
    if (!map.has(key)) map.set(key, positions);
  }
  return map;
}

function pickPositions(map, slotRow) {
  if (!slotRow?.player_name || !slotRow?.player_nation || !slotRow?.player_year) {
    return null;
  }
  const key = `${slotRow.player_name}|${slotRow.player_nation}|${slotRow.player_year}`;
  return map.get(key) || null;
}
