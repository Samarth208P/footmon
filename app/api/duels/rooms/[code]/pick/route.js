import { NextResponse } from "next/server";

import {
  getRoomByCode,
  getSquad,
  listSquadSlots,
  pickSlot,
  updateRoom,
  upsertSquad,
} from "@/lib/duel-store";
import { isValidRoomCode, normaliseRoomCode } from "@/lib/room-code";
import { authoriseRoomRequest } from "@/lib/session";
import {
  DUEL_FORMATION,
  isDraftComplete,
  addressToPick,
  nextTurnDeadline,
  slotPositionFor,
  validatePick,
} from "@/lib/draft";

export const dynamic = "force-dynamic";

/**
 * POST /api/duels/rooms/:code/pick
 *
 * The authoritative draft action. The server decides whose turn it is (derived
 * from persisted pick counts, never from the client), whether the slot is legal
 * for the player's position, and whether the footballer is already used.
 *
 * Body: { slotIndex, playerName, playerPositions, playerRating, nation?, year? }
 * Auth: Bearer duel session token
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
        { error: `Cannot pick while the duel is '${room.status}'` },
        { status: 409 }
      );
    }

    // ── Load both squads to count picks and detect reuse ──────────────────
    const [creatorSquad, joinerSquad] = await Promise.all([
      upsertSquad({ roomId: room.id, player: room.creator, formation: DUEL_FORMATION }),
      upsertSquad({ roomId: room.id, player: room.joiner, formation: DUEL_FORMATION }),
    ]);

    const [creatorSlots, joinerSlots] = await Promise.all([
      listSquadSlots(creatorSquad.id),
      listSquadSlots(joinerSquad.id),
    ]);

    const totalPicks = creatorSlots.length + joinerSlots.length;
    const mine = room.creator === sender ? creatorSlots : joinerSlots;
    const mySquad = room.creator === sender ? creatorSquad : joinerSquad;

    const slotIndex = Number(body?.slotIndex);
    const verdict = validatePick({
      sender,
      creator: room.creator,
      joiner: room.joiner,
      totalPicks,
      slotIndex,
      playerName: body?.playerName,
      playerPositions: body?.playerPositions,
      usedSlotIndexes: mine.map((s) => s.slot_index),
      usedPlayerNames: mine.map((s) => s.player_name),
    });

    if (!verdict.ok) {
      return NextResponse.json({ error: verdict.error }, { status: verdict.status });
    }

    // ── Persist the pick ─────────────────────────────────────────────────
    let slot;
    try {
      slot = await pickSlot({
        squadId: mySquad.id,
        slotIndex,
        slotPos: slotPositionFor(slotIndex),
        playerName: body.playerName,
        playerPosition: Array.isArray(body.playerPositions)
          ? body.playerPositions[0]
          : body.playerPositions,
        playerRating: Number.isFinite(Number(body.playerRating))
          ? Number(body.playerRating)
          : null,
      });
    } catch (err) {
      // Unique constraints are the last line of defence against a double-submit.
      if (/duplicate key|already used/i.test(err.message)) {
        return NextResponse.json(
          { error: "That slot or player was already used" },
          { status: 409 }
        );
      }
      throw err;
    }

    // Record the rolled nation/year alongside the squad for the result screen.
    if (body.nation || body.year) {
      await upsertSquad({
        roomId: room.id,
        player: sender,
        nation: body.nation ?? mySquad.nation,
        year: Number.isFinite(Number(body.year)) ? Number(body.year) : mySquad.year,
        formation: DUEL_FORMATION,
      });
    }

    // ── Advance the turn ─────────────────────────────────────────────────
    const newTotal = totalPicks + 1;
    const complete = isDraftComplete(newTotal);

    const patch = complete
      ? { status: "simulating", current_turn: null, turn_deadline: null }
      : {
          current_turn: addressToPick({
            totalPicks: newTotal,
            creator: room.creator,
            joiner: room.joiner,
          }),
          turn_deadline: nextTurnDeadline(),
        };

    const updated = await updateRoom(room.id, patch);

    return NextResponse.json({
      slot,
      room: updated,
      totalPicks: newTotal,
      draftComplete: complete,
      nextTurn: updated.current_turn,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to record pick", details: error.message },
      { status: 500 }
    );
  }
}
