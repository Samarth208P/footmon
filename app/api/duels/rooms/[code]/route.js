import { NextResponse } from "next/server";

import { getRoomByCode, listMatchLogs, listSquads } from "@/lib/duel-store";
import { isValidRoomCode, normaliseRoomCode } from "@/lib/room-code";

export const dynamic = "force-dynamic";

/**
 * GET /api/duels/rooms/:code
 *
 * Returns the room plus enough state to restore the correct screen after a
 * refresh. Never returns the password hash — that lives in a separate,
 * server-only table and is not selected here.
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

    const { searchParams } = new URL(request.url);
    const withState = searchParams.get("state") === "1";

    if (!withState) {
      return NextResponse.json({ room });
    }

    const [squads, logs] = await Promise.all([
      listSquads(room.id),
      listMatchLogs(room.id),
    ]);

    return NextResponse.json({ room, squads, matchLogs: logs });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to load room", details: error.message },
      { status: 500 }
    );
  }
}
