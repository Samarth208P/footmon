// js/tournament.js — solo 7-match eliminator (client).
//
// The server simulates the whole ladder and returns it; this module replays it.
// That split matters: a client-reported result would make the leaderboard
// forgeable, and because the simulation is deterministic the replay shown here is
// exactly what was scored.
//
// The run is only published to the leaderboard AFTER the player has watched it.

const TournamentClient = (() => {
  const state = {
    running: false,
    run: null,
    entry: null,
    roundIndex: 0,
  };

  // ⚠️ Must stay byte-identical to buildTournamentMessage() in lib/tournament.js.
  function buildTournamentMessage({ address, squadHash, issuedAt, nonce }) {
    return [
      "FootMon tournament run",
      "",
      `Address: ${String(address).toLowerCase()}`,
      `Squad: ${squadHash}`,
      `Issued At: ${issuedAt}`,
      `Nonce: ${nonce}`,
      "",
      "Signing submits this squad for a solo tournament run.",
      "It costs no gas and sends no transaction.",
    ].join("\n");
  }

  /** Mirrors squadFingerprint() in lib/tournament.js, then SHA-256. */
  async function squadHashOf(players) {
    const fingerprint = players
      .map((p) => `${p.name}|${p.position ?? ""}|${Number(p.rating ?? 0).toFixed(2)}`)
      .sort()
      .join(";");

    const bytes = new TextEncoder().encode(fingerprint);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function randomNonce() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** Slot order must match DUEL_SLOTS on the server. */
  function squadFromGameState(gameState) {
    return gameState.slots.map((slot) => ({
      name: slot.player?.name ?? "",
      position: slot.pos,
      rating: Number(slot.player?.rating ?? 0),
    }));
  }

  /**
   * Signs and submits the squad, then plays every recorded round on screen.
   * Resolves once the player has seen the whole run.
   */
  async function startRun({ gameState, nation, year, formation, onProgress, onFinished }) {
    if (state.running) return null;

    const address = WalletManager.getAddress();
    if (!address) throw new Error("Connect your wallet first");

    const players = squadFromGameState(gameState);
    if (players.some((p) => !p.name)) {
      throw new Error("Fill all 11 slots before entering the tournament");
    }

    state.running = true;
    try {
      const payload = {
        address: address.toLowerCase(),
        issuedAt: new Date().toISOString(),
        nonce: randomNonce(),
      };
      const squadHash = await squadHashOf(players);
      const signature = await WalletManager.getSigner().signMessage(
        buildTournamentMessage({ ...payload, squadHash })
      );

      const res = await fetch("/api/tournament/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, players, nation, year, formation }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not start the tournament");

      state.run = json.run;
      state.entry = json.entry;
      state.roundIndex = 0;

      await playAllRounds({ players, onProgress });

      onFinished?.({ run: state.run, entry: state.entry });
      return { run: state.run, entry: state.entry };
    } finally {
      state.running = false;
    }
  }

  /** Replays each round in sequence, waiting for the player between matches. */
  async function playAllRounds({ players, onProgress }) {
    const rounds = state.run?.rounds ?? [];

    for (let i = 0; i < rounds.length; i++) {
      const round = rounds[i];
      state.roundIndex = i;
      onProgress?.({ round: round.round, total: 7, won: round.won });

      MatchView.showKickoff({
        homeName: `${ProfileManager.getMyUsername() || "You"} — Match ${round.round}/7`,
        awayName: round.opponentName,
        homePlayers: players.map((p) => ({ name: p.name, slotPos: p.position })),
        awayPlayers: round.opponentPlayers.map((p) => ({
          name: p.name,
          slotPos: p.position,
        })),
      });

      // Brief beat so the line-ups register before kickoff.
      await wait(1400);

      await new Promise((resolve) => {
        MatchView.playMatch(normaliseEvents(round.events), {
          mySide: "creator",
          onFinished: resolve,
        });
      });

      const isLast = i === rounds.length - 1;
      const eliminated = !round.won;

      await showRoundOutcome({ round, isLast, eliminated, players });

      if (eliminated) break;
    }
  }

  /** Engine events use camelCase; MatchView also accepts the DB shape. */
  function normaliseEvents(events) {
    return (events ?? []).map((e) => ({
      seq: e.seq,
      minute: e.minute,
      event_type: e.eventType ?? e.event_type,
      team: e.team,
      scorer_name: e.scorerName ?? e.scorer_name ?? null,
      score_creator: e.scoreCreator ?? e.score_creator ?? 0,
      score_joiner: e.scoreJoiner ?? e.score_joiner ?? 0,
    }));
  }

  function showRoundOutcome({ round, isLast, eliminated, players }) {
    return new Promise((resolve) => {
      const scorers = normaliseEvents(round.events)
        .filter((e) => e.event_type === "goal" && e.team === "creator")
        .map((e) => ({ name: e.scorer_name, minute: e.minute }));

      let note;
      if (eliminated) {
        note = `Knocked out in round ${round.round}. ${state.run.wins} win${
          state.run.wins === 1 ? "" : "s"
        } — recording your run.`;
      } else if (isLast) {
        note = "Champion — all seven matches won!";
      } else {
        note = `Round ${round.round} won. Next up: round ${round.round + 1} of 7.`;
      }

      MatchView.showResult({
        result: round.won ? "win" : round.playerScore === round.opponentScore ? "draw" : "loss",
        myScore: round.playerScore,
        theirScore: round.opponentScore,
        scorers,
        canClaim: false,
        note,
      });

      // Advance on the player's click so nobody misses a result.
      const handler = () => {
        document.removeEventListener("match:closed", handler);
        resolve();
      };
      document.addEventListener("match:closed", handler);
    });
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const getRun = () => state.run;
  const getEntry = () => state.entry;
  const isRunning = () => state.running;

  return { startRun, getRun, getEntry, isRunning, buildTournamentMessage };
})();
