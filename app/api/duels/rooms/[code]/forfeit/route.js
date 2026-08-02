import { NextResponse } from "next/server";

import { appendMatchLog, getRoomByCode, listMatchLogs, updateRoom } from "@/lib/duel-store";
import { isValidRoomCode, normaliseRoomCode } from "@/lib/room-code";
import { authoriseRoomRequest } from "@/lib/session";
import { recordDuelOutcome, settleDuelOnChain, winnerPayoutWei } from "@/lib/duel-resolution";
import { getContract, isChainConfigured } from "@/lib/chain";

export const dynamic = "force-dynamic";

/**
 * POST /api/duels/rooms/:code/forfeit
 *
 * Self-forfeit. The caller voluntarily gives up the duel. There is no
 * longer an "opponent's clock expired" path — a turn timeout only applies
 * a rating penalty and lets the drafter finish picking. The only ways a
 * duel ends before the draft completes are:
 *
 *   * status = "open" (waiting)  -> the creator abandons the room before
 *     anyone joined. Room is marked cancelled and no one wins. The
 *     on-chain refund is initiated separately by the client's cancelDuel
 *     contract call, so this endpoint just cleans up server-side state.
 *
 *   * status = "full" | "ready"  -> one of the two players bails before
 *     both have staked. Room is cancelled; the same on-chain refund
 *     flow applies.
 *
 *   * status = "drafting"        -> the caller gives up mid-draft. The
 *     opponent is declared the winner and the pot settles to them.
 *
 * Body: { reason?: "quit" | "timeout" | "disconnect" }
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
  const reason = body?.reason === "timeout" || body?.reason === "disconnect"
    ? body.reason
    : "quit";

  try {
    let room = await getRoomByCode(roomCode);
    if (!room) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 });
    }

    const auth = authoriseRoomRequest(request, room.id);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    const caller = auth.address;

    if (room.status === "complete" || room.status === "cancelled") {
      return NextResponse.json({ room, alreadyComplete: true });
    }
    if (room.creator !== caller && room.joiner !== caller) {
      return NextResponse.json({ error: "You are not in this duel" }, { status: 403 });
    }

    // ── Pre-match cancel: no opponent yet or nobody has staked ─────────────
    // Room dies without a winner. Refunds happen via the contract's
    // cancelDuel path, which the client already invokes from its cancel
    // button when a stake was posted.
    if (["open", "full", "ready"].includes(room.status)) {
      room = await updateRoom(room.id, {
        status: "cancelled",
        current_turn: null,
        turn_deadline: null,
        current_roll_nation: null,
        current_roll_year: null,
        current_roll_at: null,
      });
      return NextResponse.json({
        room,
        cancelled: true,
        reason,
      });
    }

    if (room.status !== "drafting") {
      return NextResponse.json(
        { error: `Cannot forfeit while the duel is '${room.status}'` },
        { status: 409 }
      );
    }

    // ── Mid-draft forfeit: caller loses, opponent wins ────────────────────
    if (!room.joiner) {
      return NextResponse.json({ error: "The duel has no opponent yet" }, { status: 409 });
    }
    const winner = room.creator === caller ? room.joiner : room.creator;

    const logs = await listMatchLogs(room.id);
    await appendMatchLog({
      roomId: room.id,
      mode: "duel",
      seq: logs.length,
      minute: 0,
      eventType: "forfeit",
      team: room.creator === caller ? "creator" : "joiner",
      payload: { reason, forfeitedBy: caller },
    });

    room = await updateRoom(room.id, {
      winner,
      is_draw: false,
      current_turn: null,
      turn_deadline: null,
      current_roll_nation: null,
      current_roll_year: null,
      current_roll_at: null,
    });

    let settlement = { ok: false, error: "chain not configured" };
    if (isChainConfigured()) {
      settlement = await settleDuelOnChain({
        room,
        winnerAddress: winner,
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
    }

    room = await updateRoom(room.id, {
      status: "complete",
      ...(settlement.ok
        ? { resolver_tx: settlement.txHash, resolved_at: new Date().toISOString() }
        : {}),
    });
    await recordDuelOutcome({ room, winnerAddress: winner, isDraw: false, payoutWei });

    return NextResponse.json({
      room,
      forfeitedBy: caller,
      winner,
      settled: settlement.ok,
      settlementError: settlement.ok ? null : settlement.error,
      settlementTx: settlement.txHash ?? null,
      payoutWei,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to forfeit", details: error.message },
      { status: 500 }
    );
  }
}
