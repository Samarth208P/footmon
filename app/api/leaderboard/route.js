import { NextResponse } from "next/server";

import { listDuelLeaderboard, listTournamentLeaderboard } from "@/lib/duel-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/leaderboard?board=duel|tournament|both&limit=50
 *
 * Both boards come from ranked views that already join profiles, so entries
 * carry usernames rather than addresses.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const board = searchParams.get("board") || "both";
  const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") || 50)));

  try {
    const payload = {};

    if (board === "duel" || board === "both") {
      payload.duel = await listDuelLeaderboard(limit);
    }
    if (board === "tournament" || board === "both") {
      payload.tournament = await listTournamentLeaderboard(limit);
    }

    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to load leaderboards", details: error.message },
      { status: 500 }
    );
  }
}
