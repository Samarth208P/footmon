import { NextResponse } from "next/server";

import { createRoom, getRoomByCode, getRoomByDuelId, listOpenRooms } from "@/lib/duel-store";
import { generateUniqueRoomCode } from "@/lib/room-code";
import { hashPassword, validatePassword } from "@/lib/password";
import { isValidAddress, normaliseAddress } from "@/lib/username";
import { isChainConfigured, verifyDuelOpen } from "@/lib/chain";

export const dynamic = "force-dynamic";

/** GET /api/duels/rooms — public lobby. Private rooms are never listed. */
export async function GET() {
  try {
    const rooms = await listOpenRooms();
    return NextResponse.json({ rooms });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to list rooms", details: error.message },
      { status: 500 }
    );
  }
}

/**
 * POST /api/duels/rooms
 *
 * Registers a room for a duel that is ALREADY escrowed on-chain. The stake is
 * read from the contract, never from the request body — otherwise a client
 * could advertise a 10 MON duel while escrowing nothing.
 *
 * Body: { duelId, creator, isPrivate?, password? }
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const { duelId, creator, isPrivate = false, password = null } = body ?? {};

  if (typeof duelId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(duelId)) {
    return NextResponse.json({ error: "Invalid duelId" }, { status: 400 });
  }
  if (!isValidAddress(creator)) {
    return NextResponse.json({ error: "Invalid creator address" }, { status: 400 });
  }

  const wantsPrivate = Boolean(isPrivate);
  if (wantsPrivate) {
    const check = validatePassword(password);
    if (!check.ok) {
      return NextResponse.json({ error: check.reason }, { status: 400 });
    }
  }

  const normalisedDuelId = duelId.toLowerCase();
  const normalisedCreator = normaliseAddress(creator);

  try {
    // Idempotency: re-posting after a flaky response must not create a second room.
    const existing = await getRoomByDuelId(normalisedDuelId);
    if (existing) {
      return NextResponse.json({ room: existing, existing: true });
    }

    if (!isChainConfigured()) {
      return NextResponse.json(
        { error: "CONTRACT_ADDRESS is not configured on the server" },
        { status: 503 }
      );
    }

    // The chain is the authority on who staked what.
    const onChain = await verifyDuelOpen(normalisedDuelId, normalisedCreator);
    if (!onChain.ok) {
      return NextResponse.json({ error: onChain.error }, { status: 409 });
    }

    const roomCode = await generateUniqueRoomCode(
      async (code) => Boolean(await getRoomByCode(code))
    );

    const room = await createRoom({
      duelId: normalisedDuelId,
      roomCode,
      creator: normalisedCreator,
      stake: onChain.stake.toString(),
      isPrivate: wantsPrivate,
      passwordHash: wantsPrivate ? await hashPassword(password) : null,
    });

    return NextResponse.json({ room }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to create room", details: error.message },
      { status: 500 }
    );
  }
}
