import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

import { getRoomByCode, updateRoom, upsertSquad } from "@/lib/duel-store";
import { isValidRoomCode, normaliseRoomCode } from "@/lib/room-code";
import { authoriseRoomRequest } from "@/lib/session";
import {
  DUEL_FORMATION,
  nextTurnDeadline,
  readyDeadline,
} from "@/lib/draft";

export const dynamic = "force-dynamic";

/**
 * POST /api/duels/rooms/:code/ready
 *
 * Marks the caller ready. The draft only begins when BOTH sides are ready, and
 * the seeds are written at that moment — before any pick or simulation — so the
 * match is auditable and reproducible from stored state.
 *
 * Requires a duel session token (Authorization: Bearer ...).
 */
export async function POST(request, { params }) {
  const { code } = await params;
  const roomCode = normaliseRoomCode(code);

  if (!isValidRoomCode(roomCode)) {
    return NextResponse.json({ error: "Invalid room code" }, { status: 400 });
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
    const player = auth.address;

    if (!room.joiner) {
      return NextResponse.json({ error: "The duel has no opponent yet" }, { status: 409 });
    }
    if (!["full", "ready"].includes(room.status)) {
      return NextResponse.json(
        { error: `Cannot ready up while the duel is '${room.status}'` },
        { status: 409 }
      );
    }

    const isCreator = room.creator === player;
    const isJoiner = room.joiner === player;
    if (!isCreator && !isJoiner) {
      return NextResponse.json({ error: "You are not in this duel" }, { status: 403 });
    }

    const patch = isCreator ? { creator_ready: true } : { joiner_ready: true };

    // Start the ready countdown on the first ready, so a no-show opponent can
    // be refunded rather than leaving the stake stuck.
    if (!room.ready_deadline) {
      patch.ready_deadline = readyDeadline();
    }

    const bothReady =
      (isCreator ? true : room.creator_ready) && (isJoiner ? true : room.joiner_ready);

    if (bothReady) {
      patch.status = "drafting";
      patch.current_turn = room.creator; // creator picks first
      patch.turn_deadline = nextTurnDeadline();
      // Seeds recorded BEFORE any pick, so the result can be re-derived later.
      patch.draft_seed = room.draft_seed || randomBytes(16).toString("hex");
      patch.match_seed = room.match_seed || randomBytes(16).toString("hex");
    } else if (room.status === "full") {
      // One side is ready: a distinct state so the UI can say "waiting for your
      // opponent to ready up" rather than showing nothing.
      patch.status = "ready";
    }

    const updated = await updateRoom(room.id, patch);

    // Ensure both squad rows exist so picks have somewhere to land.
    if (bothReady) {
      await Promise.all([
        upsertSquad({ roomId: room.id, player: room.creator, formation: DUEL_FORMATION }),
        upsertSquad({ roomId: room.id, player: room.joiner, formation: DUEL_FORMATION }),
      ]);
    }

    return NextResponse.json({
      room: updated,
      bothReady,
      started: bothReady,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to ready up", details: error.message },
      { status: 500 }
    );
  }
}
