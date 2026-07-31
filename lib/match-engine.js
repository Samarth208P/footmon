/**
 * Deterministic football match simulation.
 *
 * Determinism is a correctness requirement, not a nicety: the winner decides who
 * receives escrowed MON, so a disputed result must be reproducible from the seed
 * that was recorded BEFORE the match ran. Same seed + same squads => same
 * scoreline, same minutes, same scorers, byte for byte.
 *
 * Pure module: no clock, no network, no Math.random.
 */

// ── Seeded PRNG ─────────────────────────────────────────────────────────────

/** xmur3 string hash → 32-bit seed stream. */
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function next() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32: small, fast, good enough distribution for a game sim. */
function mulberry32(a) {
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed) {
  const seeder = xmur3(String(seed));
  return mulberry32(seeder());
}

// ── Squad strength ──────────────────────────────────────────────────────────

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Attacking weight for goal attribution. Mirrors the client's notion of an
 * attack score, falling back through the shapes used across the codebase, and
 * finally to position so a squad without explicit stats still behaves sensibly.
 */
const POSITION_ATTACK_WEIGHT = {
  GK: 0.02,
  CB: 0.15,
  LB: 0.25,
  RB: 0.25,
  LWB: 0.3,
  RWB: 0.3,
  DM: 0.3,
  CDM: 0.3,
  CM: 0.6,
  AM: 0.9,
  CAM: 0.9,
  LM: 0.7,
  RM: 0.7,
  LW: 1.1,
  RW: 1.1,
  CF: 1.3,
  SS: 1.3,
  ST: 1.4,
};

function attackWeight(player) {
  const explicit = player.attack ?? player.stats?.att;
  const base = num(explicit, NaN);
  const rating = clamp(num(player.rating, 60), 1, 100);

  const positional =
    POSITION_ATTACK_WEIGHT[String(player.position || player.slotPos || "").toUpperCase()] ?? 0.5;

  // Rating scales the positional propensity; explicit attack stats win if present.
  const strength = Number.isFinite(base) ? clamp(base, 0, 100) : rating;
  return Math.max(0.0001, (strength / 100) * positional);
}

export function teamRating(players) {
  const list = (players || []).filter(Boolean);
  if (list.length === 0) return 0;
  const sum = list.reduce((acc, p) => acc + clamp(num(p.rating, 0), 0, 100), 0);
  return sum / list.length;
}

// ── Simulation ──────────────────────────────────────────────────────────────

const FULL_TIME = 90;
const HALF_TIME = 45;

/** Expected goals for a side, from its rating advantage. */
function expectedGoals(ownRating, oppRating) {
  const diff = ownRating - oppRating;
  // ~1.35 goals at parity, scaling with the rating gap, floored so a heavy
  // underdog still has a puncher's chance.
  return clamp(1.35 + diff * 0.075, 0.25, 5.5);
}

function pickScorer(players, rng) {
  const candidates = (players || []).filter(Boolean);
  if (candidates.length === 0) return null;

  const weights = candidates.map(attackWeight);
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return candidates[Math.floor(rng() * candidates.length)];

  let ticket = rng() * total;
  for (let i = 0; i < candidates.length; i++) {
    ticket -= weights[i];
    if (ticket <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

/**
 * Simulates a 90-minute match.
 *
 * @param {object} opts
 * @param {string} opts.seed                stored before the match for auditability
 * @param {{key?: string, players: object[]}} opts.home  'creator' side
 * @param {{key?: string, players: object[]}} opts.away  'joiner' or 'ai' side
 * @returns {{
 *   seed: string, homeScore: number, awayScore: number,
 *   winner: "home"|"away"|null, events: object[],
 *   homeRating: number, awayRating: number
 * }}
 */
export function simulateMatch({ seed, home, away }) {
  if (typeof seed !== "string" || seed.length === 0) {
    throw new Error("simulateMatch: a seed string is required for determinism");
  }
  if (!home?.players?.length || !away?.players?.length) {
    throw new Error("simulateMatch: both sides need at least one player");
  }

  const homeKey = home.key || "creator";
  const awayKey = away.key || "joiner";

  const rng = createRng(seed);

  const homeRating = teamRating(home.players);
  const awayRating = teamRating(away.players);

  // Home/away expected goals, then a deterministic minute for each goal.
  const homeXg = expectedGoals(homeRating, awayRating);
  const awayXg = expectedGoals(awayRating, homeRating);

  const goals = [];
  for (const [side, xg, players] of [
    [homeKey, homeXg, home.players],
    [awayKey, awayXg, away.players],
  ]) {
    const count = poisson(xg, rng);
    for (let i = 0; i < count; i++) {
      // Minute 1..90. Goals cluster slightly later, as in real matches.
      const minute = 1 + Math.floor(Math.pow(rng(), 0.85) * FULL_TIME);
      goals.push({
        side,
        minute: clamp(minute, 1, FULL_TIME),
        scorer: pickScorer(players, rng),
      });
    }
  }

  // Chronological, with a stable tie-break so equal minutes never reorder.
  goals.sort((a, b) => a.minute - b.minute || (a.side === homeKey ? -1 : 1));

  const events = [];
  let seq = 0;
  let homeScore = 0;
  let awayScore = 0;

  const push = (event) => {
    events.push({
      seq: seq++,
      scoreCreator: homeScore,
      scoreJoiner: awayScore,
      ...event,
    });
  };

  push({ minute: 0, eventType: "kickoff", team: null, scorerName: null });

  let halfTimeEmitted = false;
  for (const goal of goals) {
    if (!halfTimeEmitted && goal.minute > HALF_TIME) {
      push({ minute: HALF_TIME, eventType: "half_time", team: null, scorerName: null });
      halfTimeEmitted = true;
    }

    if (goal.side === homeKey) homeScore++;
    else awayScore++;

    events.push({
      seq: seq++,
      minute: goal.minute,
      eventType: "goal",
      team: goal.side,
      scorerName: goal.scorer?.name ?? null,
      scoreCreator: homeScore,
      scoreJoiner: awayScore,
      payload: {
        scorerRating: goal.scorer?.rating ?? null,
        scorerPosition: goal.scorer?.position ?? goal.scorer?.slotPos ?? null,
      },
    });
  }

  if (!halfTimeEmitted) {
    push({ minute: HALF_TIME, eventType: "half_time", team: null, scorerName: null });
  }

  push({ minute: FULL_TIME, eventType: "full_time", team: null, scorerName: null });

  return {
    seed,
    homeScore,
    awayScore,
    winner: homeScore === awayScore ? null : homeScore > awayScore ? "home" : "away",
    events,
    homeRating,
    awayRating,
  };
}

/** Knuth's method, driven by the seeded RNG. Capped to keep scorelines sane. */
function poisson(lambda, rng) {
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > l && k < 12);
  return k - 1;
}

/**
 * Builds the seven escalating AI opponents for the solo tournament.
 * Deterministic from the run seed so a run can be replayed and audited.
 */
export function buildTournamentLadder({ seed, playerRating, rounds = 7 }) {
  const rng = createRng(`${seed}:ladder`);
  const base = clamp(num(playerRating, 70), 40, 99);

  const ladder = [];
  for (let round = 1; round <= rounds; round++) {
    // Starts clearly beatable, ends clearly harder than the player's squad.
    const offset = -6 + (round - 1) * (12 / Math.max(1, rounds - 1));
    const jitter = (rng() - 0.5) * 2;
    const rating = clamp(base + offset + jitter, 40, 99);

    ladder.push({
      round,
      key: "ai",
      name: `Round ${round} XI`,
      rating,
      players: buildAiSquad(rating, `${seed}:ai:${round}`),
    });
  }
  return ladder;
}

const AI_SHAPE = ["GK", "CB", "CB", "LB", "RB", "CM", "CM", "CM", "LW", "ST", "RW"];

function buildAiSquad(rating, seed) {
  const rng = createRng(seed);
  return AI_SHAPE.map((position, index) => ({
    name: `${position}${index + 1}`,
    position,
    rating: clamp(rating + (rng() - 0.5) * 6, 40, 99),
  }));
}
