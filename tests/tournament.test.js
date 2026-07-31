import { afterAll, describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

import {
  TOURNAMENT_ROUNDS,
  buildTournamentMessage,
  compareTournamentRuns,
  runTournament,
  squadFingerprint,
} from "@/lib/tournament";
import { DUEL_SLOTS } from "@/lib/draft";
import { POST as submitRun, GET as getBoard } from "@/app/api/tournament/runs/route";

const SHAPE = DUEL_SLOTS;

const makeSquad = (rating) =>
  SHAPE.map((position, i) => ({
    name: `P${i}-${position}`,
    position,
    rating,
  }));

// ── pure ladder logic ───────────────────────────────────────────────────────

describe("tournament run", () => {
  it("is deterministic for the same seed and squad", () => {
    const a = runTournament({ seed: "t-1", players: makeSquad(80) });
    const b = runTournament({ seed: "t-1", players: makeSquad(80) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("requires a seed and a squad", () => {
    expect(() => runTournament({ players: makeSquad(80) })).toThrow(/seed/i);
    expect(() => runTournament({ seed: "s", players: [] })).toThrow(/squad/i);
  });

  it("stops at the first loss", () => {
    // A weak squad will lose early; the run must end there.
    let sawElimination = false;
    for (let i = 0; i < 40; i++) {
      const run = runTournament({ seed: `weak-${i}`, players: makeSquad(45) });
      if (!run.eliminated) continue;
      sawElimination = true;

      // Exactly one loss, and it is the final round played.
      const losses = run.rounds.filter((r) => !r.won);
      expect(losses).toHaveLength(1);
      expect(run.rounds[run.rounds.length - 1].won).toBe(false);
      expect(run.wins).toBe(run.rounds.length - 1);
      expect(run.eliminatedInRound).toBe(run.rounds[run.rounds.length - 1].round);
    }
    expect(sawElimination).toBe(true);
  });

  it("never plays more than seven rounds", () => {
    for (let i = 0; i < 60; i++) {
      const run = runTournament({ seed: `cap-${i}`, players: makeSquad(97) });
      expect(run.rounds.length).toBeLessThanOrEqual(TOURNAMENT_ROUNDS);
      expect(run.wins).toBeLessThanOrEqual(TOURNAMENT_ROUNDS);
    }
  });

  it("marks champion only on seven wins", () => {
    let sawChampion = false;
    for (let i = 0; i < 200; i++) {
      const run = runTournament({ seed: `champ-${i}`, players: makeSquad(99) });
      if (run.champion) {
        sawChampion = true;
        expect(run.wins).toBe(TOURNAMENT_ROUNDS);
        expect(run.eliminated).toBe(false);
        expect(run.rounds).toHaveLength(TOURNAMENT_ROUNDS);
        expect(run.rounds.every((r) => r.won)).toBe(true);
      } else {
        expect(run.wins).toBeLessThan(TOURNAMENT_ROUNDS);
      }
    }
    expect(sawChampion).toBe(true);
  });

  it("treats a draw as elimination in a knockout", () => {
    for (let i = 0; i < 120; i++) {
      const run = runTournament({ seed: `draw-${i}`, players: makeSquad(70) });
      for (const round of run.rounds) {
        if (round.playerScore === round.opponentScore) {
          expect(round.won).toBe(false);
        }
      }
    }
  });

  it("accumulates goals across the rounds actually played", () => {
    for (let i = 0; i < 40; i++) {
      const run = runTournament({ seed: `goals-${i}`, players: makeSquad(82) });
      const gf = run.rounds.reduce((s, r) => s + r.playerScore, 0);
      const ga = run.rounds.reduce((s, r) => s + r.opponentScore, 0);
      expect(run.goalsFor).toBe(gf);
      expect(run.goalsAgainst).toBe(ga);
      expect(run.goalDiff).toBe(gf - ga);
    }
  });

  it("advances through rounds in order", () => {
    const run = runTournament({ seed: "order", players: makeSquad(95) });
    expect(run.rounds.map((r) => r.round)).toEqual(
      run.rounds.map((_, i) => i + 1)
    );
  });

  it("gives a stronger squad more wins on average", () => {
    const avg = (rating) => {
      let total = 0;
      for (let i = 0; i < 80; i++) {
        total += runTournament({ seed: `cmp-${rating}-${i}`, players: makeSquad(rating) }).wins;
      }
      return total / 80;
    };
    expect(avg(95)).toBeGreaterThan(avg(60));
  });
});

describe("leaderboard ordering", () => {
  it("ranks wins, then goal difference, then rating, then earliest", () => {
    const rows = [
      { wins: 5, goal_diff: 10, team_rating: 90, completed_at: "2026-01-01T00:00:00Z" },
      { wins: 7, goal_diff: 3, team_rating: 70, completed_at: "2026-01-01T00:00:00Z" },
      { wins: 7, goal_diff: 9, team_rating: 71, completed_at: "2026-01-01T00:00:00Z" },
      { wins: 7, goal_diff: 9, team_rating: 88, completed_at: "2026-01-01T00:00:00Z" },
      { wins: 7, goal_diff: 9, team_rating: 88, completed_at: "2025-01-01T00:00:00Z" },
    ];
    const sorted = [...rows].sort(compareTournamentRuns);

    // Most wins first.
    expect(sorted[0].wins).toBe(7);
    // Among equal wins, better goal difference beats a higher rating.
    expect(sorted[sorted.length - 2].wins).toBe(7);
    expect(sorted[sorted.length - 2].goal_diff).toBe(3);
    // Earliest completion breaks a full tie.
    expect(sorted[0].completed_at).toBe("2025-01-01T00:00:00Z");
    // Fewer wins always last.
    expect(sorted[sorted.length - 1].wins).toBe(5);
  });

  it("accepts camelCase shapes too", () => {
    const sorted = [
      { wins: 1, goalDiff: 0, teamRating: 50 },
      { wins: 3, goalDiff: 0, teamRating: 50 },
    ].sort(compareTournamentRuns);
    expect(sorted[0].wins).toBe(3);
  });
});

describe("squad fingerprint", () => {
  it("is order independent", () => {
    const squad = makeSquad(80);
    const shuffled = [...squad].reverse();
    expect(squadFingerprint(squad)).toBe(squadFingerprint(shuffled));
  });

  it("changes when a player changes", () => {
    const a = makeSquad(80);
    const b = makeSquad(80);
    b[3] = { ...b[3], rating: 99 };
    expect(squadFingerprint(a)).not.toBe(squadFingerprint(b));
  });
});

// ── route ───────────────────────────────────────────────────────────────────

const configured = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
);
if (!configured) console.error("\n[tournament.test] SKIPPED: Supabase not configured.\n");

const randHex = (n) =>
  Array.from({ length: n }, () => "0123456789abcdef".charAt(Math.floor(Math.random() * 16))).join("");

async function signRun(wallet, players, overrides = {}) {
  const payload = {
    address: wallet.address,
    issuedAt: new Date().toISOString(),
    nonce: randHex(32),
    ...overrides,
  };
  const squadHash = createHash("sha256").update(squadFingerprint(players)).digest("hex");
  const signature = await wallet.signMessage(
    buildTournamentMessage({ ...payload, squadHash })
  );
  return { ...payload, players, signature };
}

const post = (body) =>
  submitRun(
    new Request("http://localhost/api/tournament/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );

describe.skipIf(!configured)("POST /api/tournament/runs", () => {
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const used = [];

  afterAll(async () => {
    for (const a of used) {
      await admin.from("tournament_leaderboard").delete().eq("address", a);
    }
  });

  it("records a signed run and returns the replay", async () => {
    const wallet = Wallet.createRandom();
    used.push(wallet.address.toLowerCase());

    const res = await post(await signRun(wallet, makeSquad(85)));
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.entry.address).toBe(wallet.address.toLowerCase());
    expect(json.run.rounds.length).toBeGreaterThan(0);
    expect(json.entry.wins).toBe(json.run.wins);
    // The replay carries the minute events so the client can animate them.
    expect(json.run.rounds[0].events.some((e) => e.eventType === "kickoff")).toBe(true);
  });

  it("rejects a run signed by another wallet", async () => {
    const owner = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const players = makeSquad(85);

    const payload = {
      address: owner.address,
      issuedAt: new Date().toISOString(),
      nonce: randHex(32),
    };
    const squadHash = createHash("sha256").update(squadFingerprint(players)).digest("hex");
    const signature = await attacker.signMessage(
      buildTournamentMessage({ ...payload, squadHash })
    );

    const res = await post({ ...payload, players, signature });
    expect(res.status).toBe(401);
  });

  it("rejects a squad swapped after signing", async () => {
    const wallet = Wallet.createRandom();
    const signed = await signRun(wallet, makeSquad(60));
    // Sign a weak squad, submit a strong one.
    const res = await post({ ...signed, players: makeSquad(99) });
    expect(res.status).toBe(401);
  });

  it("rejects an incomplete squad", async () => {
    const wallet = Wallet.createRandom();
    const short = makeSquad(80).slice(0, 10);
    const res = await post(await signRun(wallet, short));
    expect(res.status).toBe(400);
  });

  it("rejects a duplicated footballer", async () => {
    const wallet = Wallet.createRandom();
    const squad = makeSquad(80);
    squad[5] = { ...squad[4] };
    const res = await post(await signRun(wallet, squad));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/more than once/i);
  });

  it("rejects a player in an illegal position", async () => {
    const wallet = Wallet.createRandom();
    const squad = makeSquad(80);
    const stIndex = DUEL_SLOTS.indexOf("ST");
    squad[stIndex] = { name: "Keeper", position: "GK", rating: 90 };
    const res = await post(await signRun(wallet, squad));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot play/i);
  });

  it("rejects an out-of-range rating", async () => {
    const wallet = Wallet.createRandom();
    const squad = makeSquad(80);
    squad[2] = { ...squad[2], rating: 250 };
    const res = await post(await signRun(wallet, squad));
    expect(res.status).toBe(400);
  });

  it("rejects a stale submission", async () => {
    const wallet = Wallet.createRandom();
    const res = await post(
      await signRun(wallet, makeSquad(80), {
        issuedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      })
    );
    expect(res.status).toBe(400);
  });

  it("lists recorded runs on the leaderboard", async () => {
    const wallet = Wallet.createRandom();
    used.push(wallet.address.toLowerCase());
    await post(await signRun(wallet, makeSquad(88)));

    const res = await getBoard(new Request("http://localhost/api/tournament/runs?limit=200"));
    const { entries } = await res.json();
    expect(entries.some((e) => e.address === wallet.address.toLowerCase())).toBe(true);

    // The view already ranks; ranks must be non-decreasing down the list.
    const ranks = entries.map((e) => Number(e.rank));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});
