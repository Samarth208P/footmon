import { describe, expect, it } from "vitest";

import {
  buildTournamentLadder,
  createRng,
  simulateMatch,
  teamRating,
} from "@/lib/match-engine";

const squad = (prefix, rating, positions) =>
  positions.map((position, i) => ({
    name: `${prefix}-${position}-${i}`,
    position,
    rating,
  }));

const SHAPE = ["GK", "CB", "CB", "LB", "RB", "CM", "CM", "CM", "LW", "ST", "RW"];

const home = { key: "creator", players: squad("H", 80, SHAPE) };
const away = { key: "joiner", players: squad("A", 80, SHAPE) };

describe("seeded RNG", () => {
  it("is reproducible for the same seed", () => {
    const a = createRng("seed-1");
    const b = createRng("seed-1");
    const seqA = Array.from({ length: 50 }, () => a());
    const seqB = Array.from({ length: 50 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("differs across seeds", () => {
    const a = Array.from({ length: 20 }, createRng("seed-1"));
    const b = Array.from({ length: 20 }, createRng("seed-2"));
    expect(a).not.toEqual(b);
  });

  it("stays within [0,1)", () => {
    const rng = createRng("range");
    for (let i = 0; i < 5000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("determinism", () => {
  it("produces an identical match for the same seed and squads", () => {
    const a = simulateMatch({ seed: "match-seed-1", home, away });
    const b = simulateMatch({ seed: "match-seed-1", home, away });
    expect(a).toEqual(b);
  });

  it("produces byte-identical event streams", () => {
    const a = simulateMatch({ seed: "abc", home, away });
    const b = simulateMatch({ seed: "abc", home, away });
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });

  it("changes the outcome when the seed changes", () => {
    const results = new Set();
    for (let i = 0; i < 40; i++) {
      const r = simulateMatch({ seed: `seed-${i}`, home, away });
      results.add(`${r.homeScore}-${r.awayScore}`);
    }
    // Different seeds must not collapse to one scoreline.
    expect(results.size).toBeGreaterThan(3);
  });

  it("requires a seed", () => {
    expect(() => simulateMatch({ home, away })).toThrow(/seed/i);
    expect(() => simulateMatch({ seed: "", home, away })).toThrow(/seed/i);
  });

  it("requires both squads", () => {
    expect(() => simulateMatch({ seed: "s", home, away: { players: [] } })).toThrow();
    expect(() => simulateMatch({ seed: "s", home: { players: [] }, away })).toThrow();
  });
});

describe("scoreline integrity", () => {
  const seeds = Array.from({ length: 60 }, (_, i) => `integrity-${i}`);

  it("final score equals the number of goal events per side", () => {
    for (const seed of seeds) {
      const r = simulateMatch({ seed, home, away });
      const goals = r.events.filter((e) => e.eventType === "goal");
      expect(goals.filter((g) => g.team === "creator")).toHaveLength(r.homeScore);
      expect(goals.filter((g) => g.team === "joiner")).toHaveLength(r.awayScore);
    }
  });

  it("running score on each event matches the goals so far", () => {
    for (const seed of seeds.slice(0, 20)) {
      const r = simulateMatch({ seed, home, away });
      let h = 0;
      let a = 0;
      for (const e of r.events) {
        if (e.eventType === "goal") {
          if (e.team === "creator") h++;
          else a++;
        }
        expect(e.scoreCreator).toBe(h);
        expect(e.scoreJoiner).toBe(a);
      }
      expect(r.homeScore).toBe(h);
      expect(r.awayScore).toBe(a);
    }
  });

  it("declares the winner consistently with the score", () => {
    for (const seed of seeds) {
      const r = simulateMatch({ seed, home, away });
      if (r.homeScore > r.awayScore) expect(r.winner).toBe("home");
      else if (r.awayScore > r.homeScore) expect(r.winner).toBe("away");
      else expect(r.winner).toBeNull();
    }
  });

  it("emits kickoff, half time and full time exactly once", () => {
    for (const seed of seeds.slice(0, 25)) {
      const r = simulateMatch({ seed, home, away });
      for (const type of ["kickoff", "half_time", "full_time"]) {
        expect(r.events.filter((e) => e.eventType === type)).toHaveLength(1);
      }
    }
  });

  it("keeps seq strictly increasing and minutes ordered", () => {
    for (const seed of seeds.slice(0, 25)) {
      const r = simulateMatch({ seed, home, away });
      const seqs = r.events.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);

      const goalMinutes = r.events.filter((e) => e.eventType === "goal").map((e) => e.minute);
      expect(goalMinutes).toEqual([...goalMinutes].sort((a, b) => a - b));
    }
  });

  it("keeps every minute inside the 90-minute match", () => {
    for (const seed of seeds) {
      const r = simulateMatch({ seed, home, away });
      for (const e of r.events) {
        expect(e.minute).toBeGreaterThanOrEqual(0);
        expect(e.minute).toBeLessThanOrEqual(90);
      }
    }
  });
});

describe("goal attribution", () => {
  it("only ever credits a goal to a player on the scoring side", () => {
    const homeNames = new Set(home.players.map((p) => p.name));
    const awayNames = new Set(away.players.map((p) => p.name));

    for (let i = 0; i < 200; i++) {
      const r = simulateMatch({ seed: `attr-${i}`, home, away });
      for (const goal of r.events.filter((e) => e.eventType === "goal")) {
        expect(goal.scorerName).toBeTruthy();
        if (goal.team === "creator") {
          expect(homeNames.has(goal.scorerName)).toBe(true);
          expect(awayNames.has(goal.scorerName)).toBe(false);
        } else {
          expect(awayNames.has(goal.scorerName)).toBe(true);
          expect(homeNames.has(goal.scorerName)).toBe(false);
        }
      }
    }
  });

  it("never names a scorer on a non-goal event", () => {
    // The database enforces this too; the engine must not rely on that.
    for (let i = 0; i < 50; i++) {
      const r = simulateMatch({ seed: `nonscorer-${i}`, home, away });
      for (const e of r.events.filter((x) => x.eventType !== "goal")) {
        expect(e.scorerName).toBeNull();
      }
    }
  });

  it("favours attackers over goalkeepers", () => {
    const mixed = {
      key: "creator",
      players: [
        { name: "Keeper", position: "GK", rating: 90 },
        { name: "Striker", position: "ST", rating: 90 },
      ],
    };
    const opponent = { key: "joiner", players: squad("O", 60, SHAPE) };

    const tally = { Keeper: 0, Striker: 0 };
    for (let i = 0; i < 400; i++) {
      const r = simulateMatch({ seed: `weights-${i}`, home: mixed, away: opponent });
      for (const g of r.events.filter((e) => e.eventType === "goal" && e.team === "creator")) {
        tally[g.scorerName] = (tally[g.scorerName] ?? 0) + 1;
      }
    }
    expect(tally.Striker).toBeGreaterThan(tally.Keeper * 5);
  });
});

describe("team strength", () => {
  it("averages player ratings", () => {
    expect(teamRating([{ rating: 80 }, { rating: 90 }])).toBe(85);
    expect(teamRating([])).toBe(0);
  });

  it("gives the stronger squad more wins over many seeds", () => {
    const strong = { key: "creator", players: squad("S", 92, SHAPE) };
    const weak = { key: "joiner", players: squad("W", 62, SHAPE) };

    let strongWins = 0;
    let weakWins = 0;
    for (let i = 0; i < 300; i++) {
      const r = simulateMatch({ seed: `strength-${i}`, home: strong, away: weak });
      if (r.winner === "home") strongWins++;
      else if (r.winner === "away") weakWins++;
    }
    expect(strongWins).toBeGreaterThan(weakWins * 2);
  });

  it("stays balanced between equal squads across many seeds", () => {
    let homeWins = 0;
    let awayWins = 0;
    for (let i = 0; i < 400; i++) {
      const r = simulateMatch({ seed: `fair-${i}`, home, away });
      if (r.winner === "home") homeWins++;
      else if (r.winner === "away") awayWins++;
    }
    // No structural home advantage: neither side should dominate.
    const ratio = homeWins / Math.max(1, awayWins);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.6);
  });

  it("tolerates players with missing ratings", () => {
    const ragged = { key: "creator", players: [{ name: "X", position: "ST" }] };
    const r = simulateMatch({ seed: "ragged", home: ragged, away });
    expect(Number.isFinite(r.homeScore)).toBe(true);
  });
});

describe("tournament ladder", () => {
  it("is deterministic from the run seed", () => {
    const a = buildTournamentLadder({ seed: "run-1", playerRating: 80 });
    const b = buildTournamentLadder({ seed: "run-1", playerRating: 80 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("produces seven rounds of rising difficulty", () => {
    const ladder = buildTournamentLadder({ seed: "run-2", playerRating: 80 });
    expect(ladder).toHaveLength(7);
    expect(ladder[0].round).toBe(1);
    expect(ladder[6].round).toBe(7);
    // Last round is clearly harder than the first.
    expect(ladder[6].rating).toBeGreaterThan(ladder[0].rating + 6);
  });

  it("starts easier than the player and ends harder", () => {
    const ladder = buildTournamentLadder({ seed: "run-3", playerRating: 80 });
    expect(ladder[0].rating).toBeLessThan(80);
    expect(ladder[6].rating).toBeGreaterThan(80);
  });

  it("gives every AI opponent a full 11", () => {
    for (const rung of buildTournamentLadder({ seed: "run-4", playerRating: 75 })) {
      expect(rung.players).toHaveLength(11);
      expect(rung.players.every((p) => p.name && p.position)).toBe(true);
    }
  });
});
