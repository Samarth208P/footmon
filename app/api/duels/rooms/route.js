import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { parseEther } from "ethers";

import { createRoom, getRoomByCode, listOpenRooms } from "@/lib/duel-store";
import { generateUniqueRoomCode } from "@/lib/room-code";
import { hashPassword, validatePassword } from "@/lib/password";
import { isValidAddress, normaliseAddress } from "@/lib/username";

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
 * Creates a room BEFORE any on-chain escrow. The creator advertises the stake
 * they will match once their friend joins; the actual escrow happens when both
 * players hit "Ready" (see /ready). This keeps the flow simple:
 *   1. Create room, share code
 *   2. Friend joins with code
 *   3. Both hit "Ready" → each side signs one on-chain tx → draft starts
 *
 * Body: { creator, stake, isPrivate?, password? }
 *   stake — decimal MON string (e.g. "0.5")
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const { creator, stake, isPrivate = false, password = null } = body ?? {};

  if (!isValidAddress(creator)) {
    return NextResponse.json({ error: "Invalid creator address" }, { status: 400 });
  }

  // Parse stake (decimal MON string) → wei string. Enforce a minimum so
  // duels have real skin in the game and match the contract's expectations.
  const MIN_STAKE_WEI = parseEther("0.1");
  let stakeWei;
  try {
    const stakeStr = String(stake ?? "").trim();
    if (!/^\d+(\.\d+)?$/.test(stakeStr)) {
      return NextResponse.json({ error: "Invalid stake amount" }, { status: 400 });
    }
    stakeWei = parseEther(stakeStr);
    if (stakeWei < MIN_STAKE_WEI) {
      return NextResponse.json(
        { error: "Minimum stake is 0.1 MON" },
        { status: 400 }
      );
    }
  } catch {
    return NextResponse.json({ error: "Invalid stake amount" }, { status: 400 });
  }

  const wantsPrivate = Boolean(isPrivate);
  if (wantsPrivate) {
    const check = validatePassword(password);
    if (!check.ok) {
      return NextResponse.json({ error: check.reason }, { status: 400 });
    }
  }

  const normalisedCreator = normaliseAddress(creator);

  try {
    // Server-generated duelId — a 32-byte random hex. The client uses this
    // when it later escrows on-chain during the ready step.
    const duelId = "0x" + randomBytes(32).toString("hex");

    const roomCode = await generateUniqueRoomCode(
      async (code) => Boolean(await getRoomByCode(code))
    );

    const room = await createRoom({
      duelId,
      roomCode,
      creator: normalisedCreator,
      stake: stakeWei.toString(),
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
