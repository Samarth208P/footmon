import { NextResponse } from "next/server";

import { getRoomByCode } from "@/lib/duel-store";
import { isValidRoomCode, normaliseRoomCode } from "@/lib/room-code";
import { isValidAddress, normaliseAddress } from "@/lib/username";
import {
  createSessionToken,
  isSessionSecretConfigured,
  verifySessionClaim,
} from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/duels/rooms/:code/session
 *
 * Exchanges a single wallet signature for a room-scoped bearer token used by
 * the ready/pick endpoints. One popup per duel instead of one per pick.
 *
 * Body: { address, issuedAt, nonce, signature }
 */
export async function POST(request, { params }) {
  const { code } = await params;
  const roomCode = normaliseRoomCode(code);

  if (!isValidRoomCode(roomCode)) {
    return NextResponse.json({ error: "Invalid room code" }, { status: 400 });
  }
  if (!isSessionSecretConfigured()) {
    return NextResponse.json(
      { error: "SESSION_SECRET is not configured on the server" },
      { status: 503 }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const { address, issuedAt, nonce, signature } = body ?? {};
  if (!isValidAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  const claim = verifySessionClaim({ address, roomCode, issuedAt, nonce, signature });
  if (!claim.ok) {
    return NextResponse.json({ error: claim.error }, { status: claim.status });
  }

  try {
    const room = await getRoomByCode(roomCode);
    if (!room) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 });
    }

    // Only the two participants get a session for this room.
    const player = normaliseAddress(address);
    if (room.creator !== player && room.joiner !== player) {
      return NextResponse.json(
        { error: "You are not a participant in this duel" },
        { status: 403 }
      );
    }

    const token = createSessionToken({ roomId: room.id, address: player });
    return NextResponse.json({
      token,
      room,
      side: room.creator === player ? "creator" : "joiner",
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to open duel session", details: error.message },
      { status: 500 }
    );
  }
}
