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
 * Max boost at full chemistry (33): +5 rating points.
 * Zero chemistry: -3 penalty (squad feels disjointed).
 * Average chemistry (~16): roughly neutral.
 */
function chemistryRatingBoost(chemistry) {
  // Normalize to 0–1 range (33 is max)
  const normalized = clamp(chemistry / 33, 0, 1);
  // Map: 0 chem = -3, 0.5 chem = +1, 1.0 chem = +5
  return -3 + normalized * 8;
}

/**
 * Expected goals for a side, from its rating advantage.
 * `isHome` flag gives the player (home) side a boost to make the campaign
 * feel rewarding — roughly +0.35 xG advantage at parity.
 */
function expectedGoals(ownRating, oppRating, isHome = false) {
  const diff = ownRating - oppRating;
  // Base ~1.35 goals at parity; home advantage nudges the player up.
  const homeBoost = isHome ? 0.35 : 0;
  return clamp(1.35 + diff * 0.065 + homeBoost, 0.25, 5.5);
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

  // Hidden chemistry: silently boosts/penalises effective strength
  const homeChem = calculateChemistry(home.players);
  const awayChem = calculateChemistry(away.players);
  const homeEffective = homeRating + chemistryRatingBoost(homeChem);
  const awayEffective = awayRating + chemistryRatingBoost(awayChem);

  // Expected goals use chemistry-adjusted ratings
  const homeXg = expectedGoals(homeEffective, awayEffective, true);
  const awayXg = expectedGoals(awayEffective, homeEffective, false);

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
    // Starts clearly beatable (~-8 below player), final opponent ~+2 above.
    // This keeps rounds 1-5 fairly comfortable, with only the semifinal and
    // final presenting a serious challenge.
    const offset = -8 + (round - 1) * (10 / Math.max(1, rounds - 1));
    const jitter = (rng() - 0.5) * 1.6;
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
      players: buildAiSquad(rating, `${seed}:ai:${round}`, opponent.squad),
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

function buildAiSquad(rating, seed, squadNames) {
  const rng = createRng(seed);
  return AI_SHAPE.map((position, index) => ({
    name: (squadNames && squadNames[index]) || `${position}${index + 1}`,
    position,
    rating: clamp(rating + (rng() - 0.5) * 6, 40, 99),
  }));
}
