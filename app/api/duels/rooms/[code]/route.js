import { NextResponse } from "next/server";

import {
  getRoomByCode,
  listMatchLogs,
  listSquads,
  listSquadSlots,
} from "@/lib/duel-store";
import { isValidRoomCode, normaliseRoomCode } from "@/lib/room-code";

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
    const room = await getRoomByCode(roomCode);
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

    const squads = await listSquads(room.id);
    const bySquad = await Promise.all(
      squads.map(async (s) => ({
        player: s.player,
        formation: s.formation,
        nation: s.nation,
        year: s.year,
        slots: await listSquadSlots(s.id),
      }))
    );

    const { searchParams } = new URL(request.url);
    const withLogs = searchParams.get("state") === "1";
    const matchLogs = withLogs ? await listMatchLogs(room.id) : undefined;

    return NextResponse.json({
      room,
      squads: bySquad,
      ...(matchLogs ? { matchLogs } : {}),
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to load room", details: error.message },
      { status: 500 }
    );
  }
}
