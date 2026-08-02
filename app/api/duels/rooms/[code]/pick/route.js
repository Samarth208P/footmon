import { NextResponse } from "next/server";

import {
  getRoomByCode,
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
import { advanceExpiredTurn } from "@/lib/turn-timer";

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
    // Lazy timeout enforcement: if the CURRENT drafter has already blown
    // their 90-second deadline, apply the rating penalty and refresh the
    // deadline. The drafter still gets to make this pick — from the same
    // nation/year list — but they're now capped at rating ≤ 85.
    let room = await advanceExpiredTurn(await getRoomByCode(roomCode));
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
      upsertSquad({ roomId: room.id, player: room.creator, formation: room.creator_formation || DUEL_FORMATION }),
      upsertSquad({ roomId: room.id, player: room.joiner, formation: room.joiner_formation || DUEL_FORMATION }),
    ]);

    const [creatorSlots, joinerSlots] = await Promise.all([
      listSquadSlots(creatorSquad.id),
      listSquadSlots(joinerSquad.id),
    ]);

    // Turn ordering is driven by pick_attempts, incremented only on a
    // successful pick. Timeouts do NOT increment: they only apply a
    // rating penalty and leave the current player on the clock to
    // finish selecting from the same nation/year list.
    const attempts = Number(room.pick_attempts ?? (creatorSlots.length + joinerSlots.length));
    const mine = room.creator === sender ? creatorSlots : joinerSlots;
    const mySquad = room.creator === sender ? creatorSquad : joinerSquad;
    const myFormation = mySquad.formation || DUEL_FORMATION;

    const slotIndex = Number(body?.slotIndex);
    const verdict = validatePick({
      sender,
      creator: room.creator,
      joiner: room.joiner,
      totalPicks: attempts,
      slotIndex,
      playerName: body?.playerName,
      playerPositions: body?.playerPositions,
      usedSlotIndexes: mine.map((s) => s.slot_index),
      usedPlayerNames: mine.map((s) => s.player_name),
      formation: myFormation,
    });

    if (!verdict.ok) {
      return NextResponse.json({ error: verdict.error }, { status: verdict.status });
    }

    // ── Timeout penalty cap: rating <= 85 for the pick immediately after
    //    a missed turn. Cleared once this pick lands successfully.
    const isCreatorSender = room.creator === sender;
    const penaltyCap = isCreatorSender
      ? room.creator_penalty_max_rating
      : room.joiner_penalty_max_rating;
    const rawRating = Number.isFinite(Number(body.playerRating))
      ? Number(body.playerRating)
      : null;
    if (penaltyCap != null && rawRating != null && rawRating > penaltyCap) {
      return NextResponse.json(
        {
          error: `Timeout penalty: this pick must be rated ${penaltyCap} or lower`,
          penaltyMaxRating: penaltyCap,
        },
        { status: 409 }
      );
    }

    // ── Persist the pick ─────────────────────────────────────────────────
    // Nation and year come from the wheel roll the player was on when they
    // picked. They're stamped per-slot (not just per-squad) so a squad
    // drafted across many nations/years can still compute chemistry at
    // simulation time — a single same-nation or same-year core within
    // eleven picks matters.
    const bodyYear = Number.isFinite(Number(body.year)) ? Number(body.year) : null;
    let slot;
    try {
      slot = await pickSlot({
        squadId: mySquad.id,
        slotIndex,
        slotPos: slotPositionFor(slotIndex, myFormation),
        playerName: body.playerName,
        playerPosition: Array.isArray(body.playerPositions)
          ? body.playerPositions[0]
          : body.playerPositions,
        playerRating: rawRating,
        playerNation: typeof body.nation === "string" ? body.nation : null,
        playerYear: bodyYear,
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
        formation: myFormation,
      });
    }

    // ── Advance the turn ─────────────────────────────────────────────────
    const newAttempts = attempts + 1;
    const complete = isDraftComplete(newAttempts);

    // Clearing current_roll_* on every pick means the next drafter starts
    // with a fresh wheel, and the just-departed drafter's roll doesn't
    // linger on their opponent's screen after the turn passes. We also
    // clear THIS sender's penalty since they successfully used their
    // penalised turn.
    const commonPatch = {
      pick_attempts: newAttempts,
      current_roll_nation: null,
      current_roll_year: null,
      current_roll_at: null,
    };
    if (isCreatorSender) commonPatch.creator_penalty_max_rating = null;
    else commonPatch.joiner_penalty_max_rating = null;

    const patch = complete
      ? {
          ...commonPatch,
          status: "simulating",
          current_turn: null,
          turn_deadline: null,
        }
      : {
          ...commonPatch,
          current_turn: addressToPick({
            totalPicks: newAttempts,
            creator: room.creator,
            joiner: room.joiner,
          }),
          turn_deadline: nextTurnDeadline(),
        };

    const updated = await updateRoom(room.id, patch);

    return NextResponse.json({
      slot,
      room: updated,
      totalPicks: newAttempts,
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
