import { NextResponse } from "next/server";

import { getRoomByCode, listMatchLogs, updateRoom } from "@/lib/duel-store";
import { isValidRoomCode, normaliseRoomCode } from "@/lib/room-code";
import { authoriseRoomRequest } from "@/lib/session";
import {
  recordDuelOutcome,
  runDuelSimulation,
  settleDuelOnChain,
  winnerPayoutWei,
} from "@/lib/duel-resolution";
import { getContract, isChainConfigured } from "@/lib/chain";

export const dynamic = "force-dynamic";

/**
 * POST /api/duels/rooms/:code/simulate
 *
 * Runs the deterministic match, writes every minute tick, settles escrow via the
 * resolver, then updates leaderboards. Safe to call more than once: the stored
 * match is reused rather than re-rolled, so two clients racing to trigger the
 * match cannot produce two different scorelines.
 */
export async function POST(request, { params }) {
  const { code } = await params;
  const roomCode = normaliseRoomCode(code);

  if (!isValidRoomCode(roomCode)) {
    return NextResponse.json({ error: "Invalid room code" }, { status: 400 });
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

    if (room.status === "complete") {
      const logs = await listMatchLogs(room.id);
      return NextResponse.json({ room, matchLogs: logs, alreadyComplete: true });
    }
    if (room.status !== "simulating") {
      return NextResponse.json(
        { error: `Cannot simulate while the duel is '${room.status}'` },
        { status: 409 }
      );
    }

    const sim = await runDuelSimulation(room);

    // Re-read: runDuelSimulation writes the score and winner.
    room = await getRoomByCode(roomCode);
    const isDraw = Boolean(room.is_draw);
    const winnerAddress = room.winner;

    // ── Settle escrow ────────────────────────────────────────────────────
    let settlement = { ok: false, error: "chain not configured" };
    if (isChainConfigured()) {
      settlement = await settleDuelOnChain({ room, winnerAddress, isDraw });
    }

    let payoutWei = "0";
    if (settlement.ok && !isDraw) {
      try {
        const housePct = await getContract().duelHousePct();
        payoutWei = winnerPayoutWei(room.stake, housePct);
      } catch {
        payoutWei = "0";
      }
    }

    if (settlement.ok) {
      room = await updateRoom(room.id, {
        status: "complete",
        resolver_tx: settlement.txHash,
        resolved_at: new Date().toISOString(),
      });
      await recordDuelOutcome({ room, winnerAddress, isDraw, payoutWei });
    }

    const matchLogs = await listMatchLogs(room.id);

    return NextResponse.json({
      room,
      matchLogs,
      simulated: !sim.alreadySimulated,
      settled: settlement.ok,
      // Surfaced so the UI can say "result recorded, payout pending" rather than
      // pretending nothing happened.
      settlementError: settlement.ok ? null : settlement.error,
      // Tx hash of the resolver's push-payment call. Shown in the reveal
      // card so a curious winner can look the transfer up on-chain.
      settlementTx: settlement.txHash ?? null,
      payoutWei,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to simulate duel", details: error.message },
      { status: 500 }
    );
  }
}
