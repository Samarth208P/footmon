import { NextResponse } from "next/server";

import { getRoomByCode, getRoomPasswordHash, joinRoom } from "@/lib/duel-store";
import { isValidRoomCode, normaliseRoomCode } from "@/lib/room-code";
import { verifyPassword } from "@/lib/password";
import { isValidAddress, normaliseAddress } from "@/lib/username";
import { isChainConfigured, verifyDuelJoined } from "@/lib/chain";

export const dynamic = "force-dynamic";

/**
 * POST /api/duels/rooms/:code/join
 *
 * Order matters: the password is checked BEFORE anything else is revealed or
 * mutated, so a wrong password cannot be used to probe room state.
 *
 * Body: { joiner, password? }
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

  const { joiner, password = null } = body ?? {};
  if (!isValidAddress(joiner)) {
    return NextResponse.json({ error: "Invalid joiner address" }, { status: 400 });
  }
  const joinerAddress = normaliseAddress(joiner);

  try {
    const room = await getRoomByCode(roomCode);
    if (!room) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 });
    }

    // ── Password gate ─────────────────────────────────────────────────────
    if (room.is_private) {
      const stored = await getRoomPasswordHash(room.id);
      if (!stored) {
        return NextResponse.json(
          { error: "Room is private but has no password set" },
          { status: 500 }
        );
      }
      const ok = await verifyPassword(password ?? "", stored);
      if (!ok) {
        return NextResponse.json({ error: "Incorrect room password" }, { status: 403 });
      }
    }

    if (room.creator === joinerAddress) {
      return NextResponse.json({ error: "You cannot join your own duel" }, { status: 409 });
    }
    if (room.joiner && room.joiner !== joinerAddress) {
      return NextResponse.json({ error: "This duel already has an opponent" }, { status: 409 });
    }
    if (room.status !== "open" && room.joiner !== joinerAddress) {
      return NextResponse.json({ error: "This duel is no longer open" }, { status: 409 });
    }

    // ── Escrow gate ───────────────────────────────────────────────────────
    // The joiner must have actually matched the stake on-chain. Without this a
    // player could occupy a room without escrowing anything.
    if (!isChainConfigured()) {
      return NextResponse.json(
        { error: "CONTRACT_ADDRESS is not configured on the server" },
        { status: 503 }
      );
    }
    const onChain = await verifyDuelJoined(room.duel_id, joinerAddress);
    if (!onChain.ok) {
      return NextResponse.json({ error: onChain.error }, { status: 409 });
    }

    // Idempotent: a retried join by the same player is fine.
    if (room.joiner === joinerAddress) {
      return NextResponse.json({ room, alreadyJoined: true });
    }

    const joined = await joinRoom(room.id, joinerAddress);
    if (!joined) {
      // Lost the race to another joiner.
      return NextResponse.json({ error: "This duel already has an opponent" }, { status: 409 });
    }

    return NextResponse.json({ room: joined });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to join room", details: error.message },
      { status: 500 }
    );
  }
}
