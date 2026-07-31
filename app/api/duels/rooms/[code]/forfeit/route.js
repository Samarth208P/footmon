import { NextResponse } from "next/server";

import { appendMatchLog, getRoomByCode, listMatchLogs, updateRoom } from "@/lib/duel-store";
import { isValidRoomCode, normaliseRoomCode } from "@/lib/room-code";
import { authoriseRoomRequest } from "@/lib/session";
import { isTurnExpired } from "@/lib/draft";
import { recordDuelOutcome, settleDuelOnChain, winnerPayoutWei } from "@/lib/duel-resolution";
import { getContract, isChainConfigured } from "@/lib/chain";

export const dynamic = "force-dynamic";

/**
 * POST /api/duels/rooms/:code/forfeit
 *
 * Claims a win when the opponent's turn clock has run out. The SERVER checks the
 * deadline — a client cannot simply assert that its opponent timed out, or it
 * could steal the pot at will.
 *
 * Body: { reason?: "timeout" | "disconnect" }
 */
export async function POST(request, { params }) {
  const { code } = await params;
  const roomCode = normaliseRoomCode(code);

  if (!isValidRoomCode(roomCode)) {
    return NextResponse.json({ error: "Invalid room code" }, { status: 400 });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    /* body is optional */
  }

  try {
    let room = await getRoomByCode(roomCode);
    if (!room) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 });
    }

    const auth = authoriseRoomRequest(request, room.id);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    const claimant = auth.address;

    if (room.status === "complete") {
      return NextResponse.json({ room, alreadyComplete: true });
    }
    if (!["drafting", "ready", "full"].includes(room.status)) {
      return NextResponse.json(
        { error: `Cannot forfeit while the duel is '${room.status}'` },
        { status: 409 }
      );
    }
    if (room.creator !== claimant && room.joiner !== claimant) {
      return NextResponse.json({ error: "You are not in this duel" }, { status: 403 });
    }
    if (!room.joiner) {
      return NextResponse.json({ error: "The duel has no opponent yet" }, { status: 409 });
    }

    const opponent = room.creator === claimant ? room.joiner : room.creator;

    // You may only claim a forfeit against the player who is on the clock.
    if (room.current_turn && room.current_turn !== opponent) {
      return NextResponse.json(
        { error: "It is your turn — you cannot claim a forfeit" },
        { status: 409 }
      );
    }
    if (!isTurnExpired(room.turn_deadline)) {
      return NextResponse.json(
        { error: "The opponent's turn has not expired yet" },
        { status: 409 }
      );
    }

    // ── Record the forfeit, then settle ───────────────────────────────────
    const logs = await listMatchLogs(room.id);
    await appendMatchLog({
      roomId: room.id,
      mode: "duel",
      seq: logs.length,
      minute: 0,
      eventType: "forfeit",
      team: room.creator === claimant ? "joiner" : "creator",
      payload: { reason: body?.reason === "disconnect" ? "disconnect" : "timeout", forfeitedBy: opponent },
    });

    room = await updateRoom(room.id, {
      winner: claimant,
      is_draw: false,
      current_turn: null,
      turn_deadline: null,
    });

    let settlement = { ok: false, error: "chain not configured" };
    if (isChainConfigured()) {
      settlement = await settleDuelOnChain({
        room,
        winnerAddress: claimant,
        isDraw: false,
      });
    }

    let payoutWei = "0";
    if (settlement.ok) {
      try {
        payoutWei = winnerPayoutWei(room.stake, await getContract().duelHousePct());
      } catch {
        payoutWei = "0";
      }
      room = await updateRoom(room.id, {
        status: "complete",
        resolver_tx: settlement.txHash,
        resolved_at: new Date().toISOString(),
      });
      await recordDuelOutcome({ room, winnerAddress: claimant, isDraw: false, payoutWei });
    }

    return NextResponse.json({
      room,
      forfeitedBy: opponent,
      winner: claimant,
      settled: settlement.ok,
      settlementError: settlement.ok ? null : settlement.error,
      payoutWei,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to claim forfeit", details: error.message },
      { status: 500 }
    );
  }
}
