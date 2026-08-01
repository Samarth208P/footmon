import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

import { runTournament, TOURNAMENT_ROUNDS } from "@/lib/tournament";
import { SQUAD_SIZE, slotPositionFor } from "@/lib/draft";
import { getServerClient } from "@/lib/supabase-server";
import { buildTournamentLadder, teamRating } from "@/lib/match-engine";

export const dynamic = "force-dynamic";

/**
 * POST /api/tournament/simulate
 *
 * Runs a solo tournament simulation WITHOUT recording the result and WITHOUT
 * requiring a wallet signature. The client uses this to preview the outcome
 * and decide whether to commit (sign + POST /api/tournament/runs) to the
 * leaderboard.
 *
 * The returned `seed` must be sent back to /runs to lock the recorded run to
 * this preview — the server re-simulates with the same seed for verification.
 *
 * Body: { players[11] }
 * Returns: { seed, run, champion, rounds }
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const { players } = body ?? {};
  if (!Array.isArray(players) || players.length !== SQUAD_SIZE) {
    return NextResponse.json(
      { error: `A full squad of ${SQUAD_SIZE} players is required` },
      { status: 400 }
    );
  }

  // Basic per-player validation. This mirrors /runs so a preview can't
  // succeed on a squad that would later be rejected at commit time.
  const names = new Set();
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p || typeof p.name !== "string" || p.name.trim() === "") {
      return NextResponse.json({ error: `Player ${i + 1} has no name` }, { status: 400 });
    }
    if (names.has(p.name)) {
      return NextResponse.json({ error: `${p.name} appears more than once` }, { status: 400 });
    }
    names.add(p.name);
    const rating = Number(p.rating);
    if (!Number.isFinite(rating) || rating < 0 || rating > 100) {
      return NextResponse.json({ error: `${p.name} has an invalid rating` }, { status: 400 });
    }
  }

  try {
    const seed = randomBytes(16).toString("hex");

    // Build the player squad for the engine. Nation and year come from the
    // client — they're stamped onto each placed player at draft time — and
    // must reach the engine or the hidden chemistry system can't reward
    // same-nation / same-year cores.
    const playerSquad = players.map((p, i) => ({
      name: p.name,
      position: p.position ?? slotPositionFor(i),
      positions: p.positions,
      rating: Number(p.rating),
      nation: p.draftedNation ?? p.nation ?? null,
      year: Number.isFinite(Number(p.draftedYear ?? p.year))
        ? Number(p.draftedYear ?? p.year)
        : null,
      draftedNation: p.draftedNation ?? p.nation ?? null,
      draftedYear: Number.isFinite(Number(p.draftedYear ?? p.year))
        ? Number(p.draftedYear ?? p.year)
        : null,
    }));

    // Fetch real squads from the DB for AI opponents.
    // We pre-build the ladder to know which nations/years were picked,
    // then query their actual players from wc_players.
    const playerRating = teamRating(playerSquad);
    const ladder = buildTournamentLadder({ seed, playerRating, rounds: TOURNAMENT_ROUNDS });

    const supabase = getServerClient();
    if (supabase) {
      for (const rung of ladder) {
        if (!rung.nation || !rung.year) continue;
        const { data } = await supabase
          .from("wc_players")
          .select("name, position, rating")
          .eq("nation_code", rung.nation)
          .eq("year", rung.year)
          .order("rating", { ascending: false })
          .limit(11);

        if (data && data.length > 0) {
          // Replace the placeholder squad with real players. Keep the
          // placeholder's rating (which the engine has already scaled to
          // the current tournament round) and preserve nation/year so
          // the AI XI gets full same-nation, same-year chemistry.
          rung.players = rung.players.map((placeholder, idx) => {
            const real = data[idx % data.length];
            return {
              ...placeholder,
              name: real.name,
              position: real.position || placeholder.position,
              nation: rung.nation,
              year: rung.year,
              draftedNation: rung.nation,
              draftedYear: rung.year,
            };
          });
        }
      }
    }

    const result = runTournament({ seed, players: playerSquad, ladder });

    return NextResponse.json({
      seed,
      run: result,
      champion: result.champion,
      rounds: TOURNAMENT_ROUNDS,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to simulate tournament", details: error.message },
      { status: 500 }
    );
  }
}
