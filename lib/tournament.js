import { buildTournamentLadder, simulateMatch, teamRating } from "@/lib/match-engine";

/**
 * Solo tournament: seven escalating AI opponents, single elimination.
 *
 * Runs entirely on the server from a stored seed. A client cannot be trusted to
 * report its own results — leaderboard entries would be trivially forgeable —
 * so the server simulates the whole ladder and the client merely replays it.
 * Determinism means the replay is exactly what was scored.
 */

export const TOURNAMENT_ROUNDS = 7;

/**
 * @param {object} opts
 * @param {string} opts.seed
 * @param {{name: string, position: string, rating: number}[]} opts.players player's XI
 * @returns {{
 *   seed: string, wins: number, eliminated: boolean, eliminatedInRound: number|null,
 *   goalsFor: number, goalsAgainst: number, goalDiff: number, teamRating: number,
 *   rounds: object[], champion: boolean
 * }}
 */
export function runTournament({ seed, players, ladder: prebuiltLadder }) {
  if (typeof seed !== "string" || seed.length === 0) {
    throw new Error("runTournament: a seed string is required for determinism");
  }
  if (!Array.isArray(players) || players.length === 0) {
    throw new Error("runTournament: the player squad is required");
  }

  const rating = teamRating(players);
  const ladder = prebuiltLadder || buildTournamentLadder({
    seed,
    playerRating: rating,
    rounds: TOURNAMENT_ROUNDS,
  });

  const rounds = [];
  let wins = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  let eliminatedInRound = null;

  for (const rung of ladder) {
    const match = simulateMatch({
      // Per-round seed keeps each match independent yet reproducible.
      seed: `${seed}:round:${rung.round}`,
      home: { key: "creator", players },
      away: { key: "ai", players: rung.players },
      // Real knockout football: a level game after 90' goes to penalties.
      // The engine emits pens_start / penalty / pens_end events and settles
      // on a decisive winner, so there's no need for a "draw = player wins"
      // shortcut here any more.
      knockout: true,
      // Solo mode: chemistry is off, higher-rated squads win convincingly.
      // Duels use the balanced curve where a lucky underdog can steal one.
      mode: "solo",
    });

    goalsFor += match.homeScore;
    goalsAgainst += match.awayScore;

    // With knockout=true the engine always returns "home" or "away".
    const won = match.winner === "home";

    rounds.push({
      round: rung.round,
      opponentName: rung.name,
      opponentRating: rung.rating,
      playerScore: match.homeScore,
      opponentScore: match.awayScore,
      // Regulation score is preserved on playerScore/opponentScore. The
      // shootout, if any, lives on `penalties` so the UI can render both.
      penalties: match.penalties ?? null,
      won,
      events: match.events,
      opponentPlayers: rung.players,
    });

    if (won) {
      wins++;
    } else {
      eliminatedInRound = rung.round;
      break; // one loss ends the run
    }
  }

  return {
    seed,
    wins,
    eliminated: eliminatedInRound !== null,
    eliminatedInRound,
    goalsFor,
    goalsAgainst,
    goalDiff: goalsFor - goalsAgainst,
    teamRating: rating,
    rounds,
    champion: wins === TOURNAMENT_ROUNDS,
  };
}

/**
 * Leaderboard ordering: wins, then goal difference, then team rating, then the
 * earlier run. Mirrors tournament_leaderboard_ranked in the migration so the
 * client and the database never disagree about who is first.
 */
export function compareTournamentRuns(a, b) {
  if (b.wins !== a.wins) return b.wins - a.wins;
  const gdA = a.goal_diff ?? a.goalDiff ?? 0;
  const gdB = b.goal_diff ?? b.goalDiff ?? 0;
  if (gdB !== gdA) return gdB - gdA;
  const rA = Number(a.team_rating ?? a.teamRating ?? 0);
  const rB = Number(b.team_rating ?? b.teamRating ?? 0);
  if (rB !== rA) return rB - rA;
  const tA = Date.parse(a.completed_at ?? a.completedAt ?? 0) || 0;
  const tB = Date.parse(b.completed_at ?? b.completedAt ?? 0) || 0;
  return tA - tB;
}

/**
 * The message a player signs to submit a run.
 *
 * The `seed` binds the signature to a specific simulation. The server
 * re-runs `runTournament({ seed, players })` and confirms it matches the
 * expected outcome before recording.
 */
export function buildTournamentMessage({ address, squadHash, seed, issuedAt, nonce }) {
  return [
    "FootMon tournament run",
    "",
    `Address: ${String(address).toLowerCase()}`,
    `Squad: ${squadHash}`,
    `Seed: ${seed}`,
    `Issued At: ${issuedAt}`,
    `Nonce: ${nonce}`,
    "",
    "Signing submits this squad's simulated run to the leaderboard.",
    "It costs no gas and sends no transaction.",
  ].join("\n");
}

/**
 * Canonical squad fingerprint, so the signature covers the exact XI submitted.
 * Order-independent by design: the same XI in a different slot order is the
 * same squad for signing purposes.
 */
export function squadFingerprint(players) {
  return (players || [])
    .map((p) => `${p.name}|${p.position ?? ""}|${Number(p.rating ?? 0).toFixed(2)}`)
    .sort()
    .join(";");
}
