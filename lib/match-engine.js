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

// Position weight tables. Each captures how much a given slot contributes to a
// specific phase of play. They intentionally overlap — a CDM defends, controls
// the midfield, and does a little bit going forward, so it appears in all three.
//
// Weights are calibrated against a 4-3-3 baseline where each phase's weights
// across the XI sum to a similar total; this keeps `attackRating` ~ `teamRating`
// for a well-balanced squad but rewards specialists in each area.

const POSITION_ATTACK_WEIGHT = {
  GK: 0.02,
  CB: 0.15,
  LB: 0.25,
  RB: 0.25,
  LWB: 0.30,
  RWB: 0.30,
  DM: 0.30,
  CDM: 0.30,
  CM: 0.60,
  AM: 0.90,
  CAM: 0.90,
  LM: 0.70,
  RM: 0.70,
  LW: 1.10,
  RW: 1.10,
  CF: 1.30,
  SS: 1.30,
  ST: 1.40,
};

const POSITION_DEFENCE_WEIGHT = {
  GK: 1.60,
  CB: 1.30,
  LB: 0.90,
  RB: 0.90,
  LWB: 0.80,
  RWB: 0.80,
  CDM: 0.90,
  DM: 0.90,
  CM: 0.50,
  AM: 0.20,
  CAM: 0.20,
  LM: 0.40,
  RM: 0.40,
  LW: 0.15,
  RW: 0.15,
  CF: 0.10,
  SS: 0.10,
  ST: 0.10,
};

const POSITION_MIDFIELD_WEIGHT = {
  GK: 0.00,
  CB: 0.20,
  LB: 0.30,
  RB: 0.30,
  LWB: 0.50,
  RWB: 0.50,
  CDM: 0.85,
  DM: 0.85,
  CM: 1.00,
  AM: 0.85,
  CAM: 0.85,
  LM: 0.70,
  RM: 0.70,
  LW: 0.30,
  RW: 0.30,
  CF: 0.25,
  SS: 0.25,
  ST: 0.20,
};

function normalisePos(p) {
  return String(p.slotPos || p.position || "").toUpperCase();
}

/**
 * Attacking weight for goal attribution. Mirrors the client's notion of an
 * attack score, falling back through the shapes used across the codebase, and
 * finally to position so a squad without explicit stats still behaves sensibly.
 */
function attackWeight(player) {
  const explicit = player.attack ?? player.stats?.att;
  const base = num(explicit, NaN);
  const rating = clamp(num(player.rating, 60), 1, 100);

  const positional = POSITION_ATTACK_WEIGHT[normalisePos(player)] ?? 0.5;

  // Rating scales the positional propensity; explicit attack stats win if present.
  const strength = Number.isFinite(base) ? clamp(base, 0, 100) : rating;
  return Math.max(0.0001, (strength / 100) * positional);
}

/**
 * Role-weighted average rating. Players in the "right" slot for the phase
 * count more than those on the fringes, so a striker-heavy XI won't rate
 * highly defensively even if their individual ratings are.
 */
function weightedRating(players, weightTable, fallback = 0.4) {
  const list = (players || []).filter(Boolean);
  if (list.length === 0) return 0;
  let sumW = 0;
  let sumRW = 0;
  for (const p of list) {
    const w = weightTable[normalisePos(p)] ?? fallback;
    const r = clamp(num(p.rating, 0), 0, 100);
    sumW += w;
    sumRW += r * w;
  }
  return sumW > 0 ? sumRW / sumW : teamRating(list);
}

export function teamRating(players) {
  const list = (players || []).filter(Boolean);
  if (list.length === 0) return 0;
  const sum = list.reduce((acc, p) => acc + clamp(num(p.rating, 0), 0, 100), 0);
  return sum / list.length;
}

/** How well the squad creates chances — heavily favours forwards and wingers. */
export function attackRating(players) {
  return weightedRating(players, POSITION_ATTACK_WEIGHT, 0.5);
}

/** How well the squad denies chances — heavily favours GK, CBs, holding mids. */
export function defenceRating(players) {
  return weightedRating(players, POSITION_DEFENCE_WEIGHT, 0.4);
}

/** How well the squad controls the middle of the park. */
export function midfieldRating(players) {
  return weightedRating(players, POSITION_MIDFIELD_WEIGHT, 0.4);
}

// ── Simulation ──────────────────────────────────────────────────────────────

const FULL_TIME = 90;
const HALF_TIME = 45;

// ── Hidden Chemistry System ─────────────────────────────────────────────────
// Inspired by EA FC: each player earns 0–3 chemistry points based on:
//   - Nation synergy: players from the same nation boost each other
//   - Year synergy: players from the same World Cup year boost each other
//   - Position fit: playing in natural position gives a bonus
//
// Max team chemistry = 33 (11 players × 3 points each).
// Chemistry is NEVER shown to the user — it silently influences match outcomes
// by adjusting the effective team rating used for xG calculation.

const POSITION_NATURAL = {
  GK: ["GK"],
  CB: ["CB"],
  LB: ["LB", "LWB"],
  RB: ["RB", "RWB"],
  CM: ["CM", "DM", "AM", "CDM", "CAM"],
  LM: ["LM"],
  RM: ["RM"],
  ST: ["ST", "CF", "SS"],
  LW: ["LW"],
  RW: ["RW"],
  CF: ["CF", "ST", "SS"],
};

/**
 * Calculates hidden chemistry for a squad (0–33 scale).
 * Each player gets 0–3 individual chemistry:
 *   - Nation links: 2+ same nation = +1, 4+ = +2, 7+ = +3 (max +1 from nation)
 *   - Year links: 2+ same year = +1, 4+ = +2, 7+ = +3 (max +1 from year)
 *   - Position fit: playing in natural position = +1
 */
function calculateChemistry(players) {
  if (!players || players.length === 0) return 0;

  // Count nations and years
  const nationCounts = {};
  const yearCounts = {};
  for (const p of players) {
    const nation = (p.draftedNation || p.nation || "").toUpperCase();
    const year = p.draftedYear || p.year || 0;
    if (nation) nationCounts[nation] = (nationCounts[nation] || 0) + 1;
    if (year) yearCounts[year] = (yearCounts[year] || 0) + 1;
  }

  let totalChem = 0;

  for (const p of players) {
    let chem = 0;

    // Position fit: +1 if playing in natural position
    const slotPos = (p.slotPos || p.position || "").toUpperCase();
    const playerPositions = Array.isArray(p.positions)
      ? p.positions.map(pos => pos.toUpperCase())
      : (p.position || "").toUpperCase().split("/").map(s => s.trim());
    const naturalList = POSITION_NATURAL[slotPos] || [slotPos];
    if (playerPositions.some(pos => naturalList.includes(pos))) {
      chem += 1;
    }

    // Nation synergy: how many teammates share this nation
    const nation = (p.draftedNation || p.nation || "").toUpperCase();
    const nationCount = nation ? (nationCounts[nation] || 0) : 0;
    if (nationCount >= 7) chem += 1;       // strong nation core
    else if (nationCount >= 4) chem += 0.7;
    else if (nationCount >= 2) chem += 0.4;

    // Year synergy: how many teammates from the same World Cup year
    const year = p.draftedYear || p.year || 0;
    const yearCount = year ? (yearCounts[year] || 0) : 0;
    if (yearCount >= 7) chem += 1;         // strong era core
    else if (yearCount >= 4) chem += 0.7;
    else if (yearCount >= 2) chem += 0.4;

    totalChem += clamp(chem, 0, 3);
  }

  return totalChem; // 0–33 range
}

/**
 * Converts chemistry (0–33) into an effective rating boost.
 *
 * The curve is one-sided positive: a disjointed squad simply misses out on
 * the boost, it isn't actively penalised. That keeps mixed-nation drafts
 * viable (they still play at their raw rating) while making a same-nation
 * or same-year core noticeably stronger.
 *
 *   0 chem   → +0.0 rating
 *  10 chem   → ~+1.7 rating
 *  16 chem   → ~+2.4 rating (average team)
 *  25 chem   → ~+3.1 rating
 *  33 chem   → +4.0 rating (max, e.g. a full real WC XI)
 *
 * The `n^0.7` curve front-loads the reward so even a small core of
 * teammates from the same nation or year gives a tangible bump.
 */
function chemistryBoost(chemistry) {
  const normalized = clamp(chemistry / 33, 0, 1);
  return Math.pow(normalized, 0.7) * 4;
}

/**
 * Expected goals for a side.
 *
 * The fairness dial: xG is driven primarily by the attacking side's ATTACK
 * rating vs the defending side's DEFENCE rating, plus a smaller midfield
 * edge. Because those numbers are role-weighted, an XI's shape matters —
 * a striker-heavy squad without a solid back four will concede more even
 * if their raw average rating is high.
 *
 * Two modes are tuned separately so the two game modes feel distinct:
 *
 *   "duel"  — wagered head-to-head. Balanced curve: a 10-point gap wins
 *             ~75-80% of the time, a 20-point gap ~92%. Some randomness so
 *             a well-drafted underdog still has a puncher's chance.
 *
 *   "solo"  — 7-match tournament ladder. Rating carries the day: the gap
 *             is amplified so the higher-rated team wins the great majority
 *             of matches (~92% at a 10-point gap, ~98% at 20+), leaving
 *             just enough variance for minor upsets. Base is nudged down a
 *             touch so the higher-rated side pulls ahead cleanly instead of
 *             both sides scoring a lot.
 *
 * @param {{attack: number, defence: number, midfield: number}} own
 * @param {{attack: number, defence: number, midfield: number}} opp
 * @param {"duel"|"solo"} [mode]
 */
function expectedGoals(own, opp, mode = "duel") {
  const attackEdge = own.attack - opp.defence;
  const midfieldEdge = own.midfield - opp.midfield;

  if (mode === "solo") {
    // Amplify the rating gap so the higher-rated side dominates. Wider
    // clamp on both ends: a big favourite can bury a weak opponent, but a
    // clearly outmatched side still has a floor that isn't literally zero
    // (which keeps the door cracked open for a minor upset).
    const ATTACK_K = 0.095;
    const MIDFIELD_K = 0.028;
    const BASE = 1.35;
    const xg = BASE + attackEdge * ATTACK_K + midfieldEdge * MIDFIELD_K;
    return clamp(xg, 0.12, 7.0);
  }

  // Duel — balanced. Attacking edge dominates; midfield adds a smaller
  // tempo advantage that mostly matters when the attack/defence gap is
  // small. Total goals-per-match lands around 2.8–3.0, slightly above the
  // real-football average of ~2.6 — the game feels more alive with a few
  // more chances converted.
  const ATTACK_K = 0.055;
  const MIDFIELD_K = 0.020;
  const BASE = 1.50;
  const xg = BASE + attackEdge * ATTACK_K + midfieldEdge * MIDFIELD_K;
  return clamp(xg, 0.20, 6.0);
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

// ── Penalty shootout ─────────────────────────────────────────────────────────
// Real-football knockout rules:
//   1. Five kicks per side, alternating. Home takes first (arbitrary but
//      deterministic — real football decides by coin toss, we use a fixed
//      order for reproducibility).
//   2. The shootout ends as soon as it is mathematically impossible for the
//      trailing team to catch up (a 3-0 lead after 3 kicks vs 2, for example).
//   3. If still tied after five kicks each, sudden death: one kick per side
//      per round, first to lead after both take wins. Each squad rotates
//      through its 11 players before anyone kicks twice.

const REG_PENS = 5;

/** Order the XI by attack propensity — coaches pick their best takers first. */
function orderTakers(players) {
  return [...players]
    .filter(Boolean)
    .sort((a, b) => attackWeight(b) - attackWeight(a));
}

function findGK(players) {
  const list = (players || []).filter(Boolean);
  return list.find((p) => normalisePos(p) === "GK") || list[0] || null;
}

/**
 * Simulates one kick. Real-world conversion sits around 72% across major
 * tournaments; we modulate that mildly by the taker's rating and the
 * keeper's rating so a top striker vs a top keeper still lands in a
 * believable band.
 *
 *   70 taker vs 70 keeper → 0.72
 *   90 taker vs 70 keeper → 0.82
 *   70 taker vs 90 keeper → 0.62
 *   90 taker vs 90 keeper → 0.72
 */
function kickResult(taker, keeper, rng) {
  const takerR = clamp(num(taker?.rating, 70), 40, 99);
  const keeperR = clamp(num(keeper?.rating, 70), 40, 99);
  const takerBonus = ((takerR - 70) / 20) * 0.10;
  const keeperPenalty = ((keeperR - 70) / 20) * 0.10;
  const p = clamp(0.72 + takerBonus - keeperPenalty, 0.35, 0.95);
  return rng() < p;
}

/** After a kick, is the outcome already decided? Mirrors real ABBA-style refs. */
function shootoutDecided(h, a, hTaken, aTaken, cap) {
  if (hTaken <= cap && aTaken <= cap) {
    // Standard 5 rounds: the trailing side must be mathematically alive.
    const hRemaining = cap - hTaken;
    const aRemaining = cap - aTaken;
    if (h > a + aRemaining) return true;
    if (a > h + hRemaining) return true;
    return false;
  }
  // Sudden death: decided only when both have kicked the same number of times
  // and the scores differ.
  return hTaken === aTaken && h !== a;
}

/**
 * Runs a penalty shootout between two sides. Deterministic on the seed.
 *
 * @returns {{
 *   homeScore: number, awayScore: number,
 *   winner: 'home'|'away',
 *   kicks: Array<{
 *     side: 'home'|'away', kickNumber: number, roundNumber: number,
 *     taker: object, keeper: object, scored: boolean,
 *     suddenDeath: boolean, homeScore: number, awayScore: number,
 *   }>
 * }}
 */
function simulatePenalties({ seed, home, away }) {
  const rng = createRng(seed);
  const homeTakers = orderTakers(home.players);
  const awayTakers = orderTakers(away.players);
  const homeGK = findGK(home.players);
  const awayGK = findGK(away.players);

  const kicks = [];
  let h = 0;
  let a = 0;
  let hIdx = 0;
  let aIdx = 0;
  let round = 0;

  const takeKick = (side) => {
    round = side === "home" ? round + 1 : round; // increment round when home kicks
    const isHome = side === "home";
    const taker = isHome
      ? homeTakers[hIdx % homeTakers.length]
      : awayTakers[aIdx % awayTakers.length];
    const keeper = isHome ? awayGK : homeGK;
    const scored = kickResult(taker, keeper, rng);
    if (isHome) hIdx++; else aIdx++;
    if (scored) { if (isHome) h++; else a++; }
    const kickNumber = isHome ? hIdx : aIdx;
    kicks.push({
      side,
      kickNumber,
      roundNumber: round,
      taker,
      keeper,
      scored,
      suddenDeath: round > REG_PENS,
      homeScore: h,
      awayScore: a,
    });
  };

  // ── Regulation five kicks each, alternating home → away → home → ... ───
  while (round < REG_PENS) {
    takeKick("home");
    if (shootoutDecided(h, a, hIdx, aIdx, REG_PENS)) break;
    takeKick("away");
    if (shootoutDecided(h, a, hIdx, aIdx, REG_PENS)) break;
  }

  // ── Sudden death: one kick per side per round until decided ────────────
  while (h === a) {
    takeKick("home");
    takeKick("away");
  }

  return {
    homeScore: h,
    awayScore: a,
    winner: h > a ? "home" : "away",
    kicks,
  };
}

/**
 * Simulates a 90-minute match.
 *
 * The model is role-aware: each side's xG is driven by the attacking side's
 * ATTACK rating vs the defending side's DEFENCE rating (both role-weighted)
 * plus a midfield tempo edge.
 *
 * Two modes with different personalities:
 *
 *   "duel"  — wagered head-to-head. Hidden chemistry (same-nation and
 *             same-year cores plus playing in a natural position) silently
 *             boosts both attack and defence, so a well-connected squad
 *             plays above its raw rating. Balanced xG curve so a slightly
 *             worse XI can still steal one on a good day.
 *
 *   "solo"  — solo tournament ladder. Chemistry is OFF — squads are judged
 *             purely on rating and shape. xG amplifies the rating gap so
 *             the stronger side wins convincingly the great majority of
 *             the time; there's just enough variance for minor upsets.
 *
 * Same seed + same squads + same mode => identical scoreline, minutes,
 * scorers, byte for byte.
 *
 * @param {object} opts
 * @param {string} opts.seed              stored before the match for auditability
 * @param {{key?: string, players: object[]}} opts.home  'creator' side
 * @param {{key?: string, players: object[]}} opts.away  'joiner' or 'ai' side
 * @param {boolean} [opts.knockout]       when true, a draw at 90' goes to a
 *                                        real penalty shootout — the result
 *                                        always has a decisive winner.
 * @param {"duel"|"solo"} [opts.mode]     tunes chemistry + xG sensitivity.
 *                                        Defaults to "duel" for backwards
 *                                        compatibility with tests.
 * @returns {{
 *   seed: string, homeScore: number, awayScore: number,
 *   winner: "home"|"away"|null, events: object[],
 *   homeRating: number, awayRating: number, mode: "duel"|"solo",
 *   penalties?: { homeScore: number, awayScore: number, winner: "home"|"away",
 *                 kicks: Array<object> }
 * }}
 */
export function simulateMatch({ seed, home, away, knockout = false, mode = "duel" }) {
  if (typeof seed !== "string" || seed.length === 0) {
    throw new Error("simulateMatch: a seed string is required for determinism");
  }
  if (!home?.players?.length || !away?.players?.length) {
    throw new Error("simulateMatch: both sides need at least one player");
  }

  const homeKey = home.key || "creator";
  const awayKey = away.key || "joiner";

  const rng = createRng(seed);

  // Raw averages — kept for leaderboard display; the engine uses role-weighted
  // numbers below to actually decide the match.
  const homeRating = teamRating(home.players);
  const awayRating = teamRating(away.players);

  // Hidden chemistry: silently lifts a cohesive squad's effective strength.
  // Same-nation and same-year cores both count; playing in a natural
  // position adds too. The boost is applied to both attack and defence.
  //
  // Solo mode explicitly disables chemistry — the tournament is a pure
  // rating contest, chemistry is a duel-only wrinkle. Set the boosts to
  // zero rather than skipping the calculation so the effective strength
  // shape below stays uniform.
  const chemistryOn = mode !== "solo";
  const homeChem = chemistryOn ? calculateChemistry(home.players) : 0;
  const awayChem = chemistryOn ? calculateChemistry(away.players) : 0;
  const homeBoost = chemistryOn ? chemistryBoost(homeChem) : 0;
  const awayBoost = chemistryOn ? chemistryBoost(awayChem) : 0;

  const homeStrength = {
    attack:   attackRating(home.players)   + homeBoost,
    defence:  defenceRating(home.players)  + homeBoost,
    midfield: midfieldRating(home.players) + homeBoost * 0.5,
  };
  const awayStrength = {
    attack:   attackRating(away.players)   + awayBoost,
    defence:  defenceRating(away.players)  + awayBoost,
    midfield: midfieldRating(away.players) + awayBoost * 0.5,
  };

  // Both sides play on neutral ground — no home boost. The `mode` toggle
  // just picks which sensitivity curve to use.
  const homeXg = expectedGoals(homeStrength, awayStrength, mode);
  const awayXg = expectedGoals(awayStrength, homeStrength, mode);

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

  // ── Penalty shootout (knockout matches only, when tied at 90') ──────────
  // Regulation score is preserved — pens are a separate scoreline, shown
  // alongside like real football ("1-1 after 90, 4-3 on pens").
  let overallWinner =
    homeScore === awayScore ? null : homeScore > awayScore ? "home" : "away";
  let penalties = undefined;

  if (knockout && overallWinner === null) {
    penalties = simulatePenalties({
      seed: `${seed}:pens`,
      home,
      away,
    });

    // Shootout start marker — clients pick this up to switch to the pens UI.
    events.push({
      seq: seq++,
      minute: FULL_TIME,
      eventType: "pens_start",
      team: null,
      scorerName: null,
      scoreCreator: homeScore,
      scoreJoiner: awayScore,
      payload: {},
    });

    for (const kick of penalties.kicks) {
      events.push({
        seq: seq++,
        // Kept within the DB's 0..120 minute check by design — the shootout
        // conceptually happens "at" 120'.
        minute: FULL_TIME,
        eventType: "penalty",
        team: kick.side === "home" ? homeKey : awayKey,
        // Storing the taker as scorer_name gives the migration + UI a
        // uniform "who did it" field to read from.
        scorerName: kick.taker?.name ?? null,
        // Regulation score never changes during a shootout.
        scoreCreator: homeScore,
        scoreJoiner: awayScore,
        payload: {
          scored: kick.scored,
          kickNumber: kick.kickNumber,
          roundNumber: kick.roundNumber,
          suddenDeath: kick.suddenDeath,
          homePens: kick.homeScore,
          awayPens: kick.awayScore,
          keeperName: kick.keeper?.name ?? null,
          takerRating: kick.taker?.rating ?? null,
          keeperRating: kick.keeper?.rating ?? null,
        },
      });
    }

    events.push({
      seq: seq++,
      minute: FULL_TIME,
      eventType: "pens_end",
      team: null,
      scorerName: null,
      scoreCreator: homeScore,
      scoreJoiner: awayScore,
      payload: {
        homePens: penalties.homeScore,
        awayPens: penalties.awayScore,
        winner: penalties.winner,
      },
    });

    overallWinner = penalties.winner;
  }

  return {
    seed,
    mode,
    homeScore,
    awayScore,
    winner: overallWinner,
    events,
    homeRating,
    awayRating,
    ...(penalties ? { penalties } : {}),
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
 *
 * The ladder is deliberately tilted in the player's favour: the AI starts
 * meaningfully weaker and never quite catches up to the player's own
 * rating. Paired with the solo xG curve (which rewards the higher-rated
 * side hard), this makes group-stage rounds a near-certainty and the
 * final still a real challenge without being a coin flip.
 *
 *   round 1  → ~ -12 vs the player  (walkover)
 *   round 4  → ~  -6 vs the player  (comfortable)
 *   round 7  → ~   0 vs the player  (final, ~50-55% player edge)
 */
export function buildTournamentLadder({ seed, playerRating, rounds = 7 }) {
  const rng = createRng(`${seed}:ladder`);
  const base = clamp(num(playerRating, 70), 40, 99);

  const ladder = [];
  for (let round = 1; round <= rounds; round++) {
    // Linear ramp from a big walkover to parity. The final round lands
    // at ~the player's own rating rather than above it, so the higher-
    // rated side (the player, most of the time) still gets the edge in
    // the closing games.
    const START_OFFSET = -12;
    const END_OFFSET = 0;
    const t = (round - 1) / Math.max(1, rounds - 1);
    const offset = START_OFFSET + t * (END_OFFSET - START_OFFSET);
    // Small jitter so consecutive runs feel a little different, but not
    // so much that a round-3 opponent occasionally spikes above the final.
    const jitter = (rng() - 0.5) * 1.4;
    const rating = clamp(base + offset + jitter, 40, 99);

    // Pick a believable opponent name from the pool (deterministic).
    const opIdx = Math.floor(rng() * AI_OPPONENT_NAMES.length);
    const opponent = AI_OPPONENT_NAMES[opIdx];

    ladder.push({
      round,
      key: "ai",
      name: opponent.name,
      nation: opponent.nation,
      year: opponent.year,
      rating,
      players: buildAiSquad({
        rating,
        seed: `${seed}:ai:${round}`,
        squadNames: opponent.squad,
        nation: opponent.nation,
        year: opponent.year,
      }),
    });
  }
  return ladder;
}

// World Cup teams used as AI opponent labels. Deterministically picked per seed.
// Each entry includes a real starting XI of recognizable players for that team.
export const AI_OPPONENT_NAMES = [
  { name: "Brazil 2002", nation: "BRA", year: 2002, squad: ["Marcos","Cafu","Lúcio","Roque Júnior","Roberto Carlos","Gilberto Silva","Kléberson","Ronaldinho","Rivaldo","Ronaldo","Juninho"] },
  { name: "Argentina 2022", nation: "ARG", year: 2022, squad: ["E. Martínez","Molina","Romero","Otamendi","Tagliafico","De Paul","Fernández","Mac Allister","Di María","Messi","Álvarez"] },
  { name: "France 2018", nation: "FRA", year: 2018, squad: ["Lloris","Pavard","Varane","Umtiti","Hernández","Kanté","Pogba","Mbappé","Griezmann","Giroud","Matuidi"] },
  { name: "Germany 2014", nation: "GER", year: 2014, squad: ["Neuer","Lahm","Hummels","Boateng","Höwedes","Schweinsteiger","Khedira","Kroos","Müller","Özil","Klose"] },
  { name: "Spain 2010", nation: "ESP", year: 2010, squad: ["Casillas","Ramos","Piqué","Puyol","Capdevila","Xavi","Busquets","Iniesta","Pedro","Villa","Torres"] },
  { name: "Italy 2006", nation: "ITA", year: 2006, squad: ["Buffon","Zambrotta","Cannavaro","Materazzi","Grosso","Gattuso","Pirlo","Camoranesi","Totti","Toni","Del Piero"] },
  { name: "England 1966", nation: "ENG", year: 1966, squad: ["Banks","Cohen","J. Charlton","Moore","Wilson","Stiles","B. Charlton","Peters","Ball","Hurst","Hunt"] },
  { name: "Netherlands 1974", nation: "NED", year: 1974, squad: ["Jongbloed","Suurbier","Rijsbergen","Haan","Krol","Jansen","Neeskens","Van Hanegem","Rep","Cruyff","Rensenbrink"] },
  { name: "Uruguay 1950", nation: "URU", year: 1950, squad: ["Máspoli","González","Tejera","Gambetta","Varela","Andrade","Ghiggia","Pérez","Míguez","Schiaffino","Morán"] },
  { name: "Croatia 2018", nation: "CRO", year: 2018, squad: ["Subašić","Vrsaljko","Lovren","Vida","Strinić","Modrić","Rakitić","Brozović","Perišić","Mandžukić","Rebić"] },
  { name: "Portugal 2016", nation: "POR", year: 2016, squad: ["Rui Patrício","Cédric","Pepe","Fonte","Guerreiro","William","Adrien","Moutinho","Nani","Ronaldo","Quaresma"] },
  { name: "Belgium 2018", nation: "BEL", year: 2018, squad: ["Courtois","Alderweireld","Kompany","Vertonghen","Meunier","Witsel","De Bruyne","Hazard","Fellaini","Lukaku","Mertens"] },
  { name: "Japan 2022", nation: "JPN", year: 2022, squad: ["Gonda","Sakai","Itakura","Yoshida","Nagatomo","Endo","Tanaka","Kamada","Doan","Asano","Kubo"] },
  { name: "Morocco 2022", nation: "MAR", year: 2022, squad: ["Bounou","Hakimi","Saïss","Aguerd","Mazraoui","Amrabat","Ounahi","Boufal","Ziyech","En-Nesyri","Amallah"] },
  { name: "Cameroon 1990", nation: "CMR", year: 1990, squad: ["N'Kono","Tataw","Massing","Ebwellé","Ndip","Mbida","M'Fédé","Makanaky","Omam-Biyik","Milla","Pagal"] },
  { name: "Ghana 2010", nation: "GHA", year: 2010, squad: ["Kingson","Pantsil","Mensah","Vorsah","Sarpei","Annan","Inkoom","K.P. Boateng","A. Gyan","Appiah","Muntari"] },
  { name: "Mexico 1986", nation: "MEX", year: 1986, squad: ["Larios","Trejo","Quirarte","F. Cruz","Servín","Muñoz","Aguirre","Negrete","Boy","De los Cobos","Sánchez"] },
  { name: "Colombia 2014", nation: "COL", year: 2014, squad: ["Ospina","Zúñiga","Zapata","Yepes","Armero","Cuadrado","Sánchez","Aguilar","J. Rodríguez","Gutiérrez","Jackson"] },
  { name: "Chile 2014", nation: "CHI", year: 2014, squad: ["Bravo","Isla","Medel","Jara","Mena","Vidal","Díaz","Aránguiz","Sánchez","Valdivia","Vargas"] },
  { name: "Sweden 1994", nation: "SWE", year: 1994, squad: ["Ravelli","R. Nilsson","P. Andersson","Björklund","Kåmark","Schwarz","Thern","Brolin","Ingesson","Dahlin","K. Andersson"] },
  { name: "Nigeria 1998", nation: "NGA", year: 1998, squad: ["Rufai","West","Okechukwu","Babayaro","Oliseh","Okocha","Lawal","Finidi","Ikpeba","Babangida","Kanu"] },
  { name: "Senegal 2002", nation: "SEN", year: 2002, squad: ["Sylva","Cissé","Diatta","Daf","Sarr","P. Diop","Fadiga","H. Camara","Diouf","S. Camara","Ndiaye"] },
  { name: "Austria 1978", nation: "AUT", year: 1978, squad: ["Koncilia","Sara","Obermayer","Pezzey","Breitenberger","Prohaska","Hickersberger","Jara","Kreuz","Krankl","Schachner"] },
  { name: "Egypt 1990", nation: "EGY", year: 1990, squad: ["Shobair","Hassan","Yassine","Ramzy","Hany","Youssef","Abdel-Hamid","Abdelghani","Tolba","Abou-Zeid","Hassan Shehata"] },
];

const AI_SHAPE = ["GK", "CB", "CB", "LB", "RB", "CM", "CM", "CM", "LW", "ST", "RW"];

/**
 * Builds an AI XI in the fixed 4-3-3 shape from an opponent template.
 *
 * Every player is stamped with the opponent's nation and year — that's what
 * lets the chemistry system see the AI as a full same-nation, same-era core
 * and correctly hand them a maxed-out chemistry boost. Without this the AI
 * would silently play at 0 chemistry while a well-drafted human XI played
 * at near-max, which would be quietly but seriously unfair.
 */
function buildAiSquad({ rating, seed, squadNames, nation, year }) {
  const rng = createRng(seed);
  return AI_SHAPE.map((position, index) => ({
    name: (squadNames && squadNames[index]) || `${position}${index + 1}`,
    position,
    rating: clamp(rating + (rng() - 0.5) * 6, 40, 99),
    // Stamp both `nation`/`year` and the drafted-* aliases so calculateChemistry
    // finds them regardless of which naming convention the caller uses.
    nation: nation ?? null,
    year: year ?? null,
    draftedNation: nation ?? null,
    draftedYear: year ?? null,
  }));
}
