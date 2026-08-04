// lib/constants.js — Shared constants for the FootMon app
// Used by both client components and server-side code.

// v2 (push-payment) deploy — replaces the pull-payment contract at
// 0xe1A532DFC4F020970d07373F8469558150443c8d. The old address is still
// live for anyone with in-flight duels or unclaimed prizes on it.
export const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS;

export const MONAD_CHAIN = {
  chainId: "0x279F",
  chainName: "Monad Testnet",
  rpcUrls: ["https://testnet-rpc.monad.xyz"],
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  blockExplorerUrls: ["https://explorer.testnet.monad.xyz"],
};

// ── Roll economics ──────────────────────────────────────────────────────────
export const SQUAD_TURNS = 11;
export const REROLL_PRICE_MON = "0.01";
// Prize pool contribution per credit-based reroll (settled daily by server)
export const CREDIT_PRIZE_CONTRIBUTION_MON = "0.005";


// ── Position Compatibility ──────────────────────────────────────────────────
export const POSITION_COMPAT = {
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

// ── Formations ──────────────────────────────────────────────────────────────
export const FORMATIONS = {
  "4-3-3": {
    label: "4-3-3",
    slots: [
      { pos: "GK", top: 86, left: 50 },
      { pos: "LB", top: 70, left: 14 },
      { pos: "CB", top: 71, left: 35 },
      { pos: "CB", top: 71, left: 65 },
      { pos: "RB", top: 70, left: 86 },
      { pos: "CM", top: 51, left: 26 },
      { pos: "CM", top: 50, left: 50 },
      { pos: "CM", top: 51, left: 74 },
      { pos: "LW", top: 23, left: 14 },
      { pos: "ST", top: 17, left: 50 },
      { pos: "RW", top: 23, left: 86 },
    ],
  },
  "4-4-2": {
    label: "4-4-2",
    slots: [
      { pos: "GK", top: 86, left: 50 },
      { pos: "LB", top: 70, left: 14 },
      { pos: "CB", top: 71, left: 35 },
      { pos: "CB", top: 71, left: 65 },
      { pos: "RB", top: 70, left: 86 },
      { pos: "LM", top: 50, left: 12 },
      { pos: "CM", top: 51, left: 35 },
      { pos: "CM", top: 51, left: 65 },
      { pos: "RM", top: 50, left: 88 },
      { pos: "ST", top: 18, left: 35 },
      { pos: "ST", top: 18, left: 65 },
    ],
  },
  "4-2-3-1": {
    label: "4-2-3-1",
    slots: [
      { pos: "GK", top: 86, left: 50 },
      { pos: "LB", top: 70, left: 14 },
      { pos: "CB", top: 71, left: 35 },
      { pos: "CB", top: 71, left: 65 },
      { pos: "RB", top: 70, left: 86 },
      { pos: "CM", top: 58, left: 37 },
      { pos: "CM", top: 58, left: 63 },
      { pos: "LM", top: 40, left: 14 },
      { pos: "CM", top: 39, left: 50 },
      { pos: "RM", top: 40, left: 86 },
      { pos: "ST", top: 18, left: 50 },
    ],
  },
  "4-2-4": {
    label: "4-2-4",
    slots: [
      { pos: "GK", top: 86, left: 50 },
      { pos: "LB", top: 70, left: 14 },
      { pos: "CB", top: 71, left: 35 },
      { pos: "CB", top: 71, left: 65 },
      { pos: "RB", top: 70, left: 86 },
      { pos: "CM", top: 51, left: 37 },
      { pos: "CM", top: 51, left: 63 },
      { pos: "LW", top: 18, left: 12 },
      { pos: "ST", top: 16, left: 37 },
      { pos: "ST", top: 16, left: 63 },
      { pos: "RW", top: 18, left: 88 },
    ],
  },
  "3-5-2": {
    label: "3-5-2",
    slots: [
      { pos: "GK", top: 86, left: 50 },
      { pos: "CB", top: 71, left: 24 },
      { pos: "CB", top: 70, left: 50 },
      { pos: "CB", top: 71, left: 76 },
      { pos: "LM", top: 50, left: 10 },
      { pos: "CM", top: 51, left: 31 },
      { pos: "CM", top: 53, left: 50 },
      { pos: "CM", top: 51, left: 69 },
      { pos: "RM", top: 50, left: 90 },
      { pos: "ST", top: 18, left: 35 },
      { pos: "ST", top: 18, left: 65 },
    ],
  },
  "5-3-2": {
    label: "5-3-2",
    slots: [
      { pos: "GK", top: 86, left: 50 },
      { pos: "LB", top: 72, left: 8 },
      { pos: "CB", top: 70, left: 26 },
      { pos: "CB", top: 69, left: 50 },
      { pos: "CB", top: 70, left: 74 },
      { pos: "RB", top: 72, left: 92 },
      { pos: "CM", top: 50, left: 28 },
      { pos: "CM", top: 49, left: 50 },
      { pos: "CM", top: 50, left: 72 },
      { pos: "ST", top: 18, left: 35 },
      { pos: "ST", top: 18, left: 65 },
    ],
  },
  "4-5-1": {
    label: "4-5-1",
    slots: [
      { pos: "GK", top: 86, left: 50 },
      { pos: "LB", top: 70, left: 14 },
      { pos: "CB", top: 71, left: 35 },
      { pos: "CB", top: 71, left: 65 },
      { pos: "RB", top: 70, left: 86 },
      { pos: "LM", top: 50, left: 10 },
      { pos: "CM", top: 51, left: 28 },
      { pos: "CM", top: 53, left: 50 },
      { pos: "CM", top: 51, left: 72 },
      { pos: "RM", top: 50, left: 90 },
      { pos: "ST", top: 18, left: 50 },
    ],
  },
  "3-4-3": {
    label: "3-4-3",
    slots: [
      { pos: "GK", top: 86, left: 50 },
      { pos: "CB", top: 71, left: 24 },
      { pos: "CB", top: 70, left: 50 },
      { pos: "CB", top: 71, left: 76 },
      { pos: "LM", top: 51, left: 16 },
      { pos: "CM", top: 50, left: 38 },
      { pos: "CM", top: 50, left: 62 },
      { pos: "RM", top: 51, left: 84 },
      { pos: "LW", top: 19, left: 14 },
      { pos: "ST", top: 16, left: 50 },
      { pos: "RW", top: 19, left: 86 },
    ],
  },
};

export const STYLE_OFFSET = { defensive: 4, balanced: 0, attacking: -4 };

// ── ISO-3 → ISO-2 flag mapping ─────────────────────────────────────────────
export const ISO3_TO_2 = {
  ARG: "AR", AUS: "AU", AUT: "AT", BEL: "BE", BIH: "BA", BOL: "BO", BRA: "BR",
  BGR: "BG", CAN: "CA", CHL: "CL", CHI: "CL", CHN: "CN", CMR: "CM", COD: "CD",
  COL: "CO", CRI: "CR", CRO: "HR", HRV: "HR", CSK: "CZ", CUW: "CW", CZE: "CZ",
  DDR: "DE", DEU: "DE", GER: "DE", DZA: "DZ", ALG: "DZ", ECU: "EC", EGY: "EG",
  ENG: "GB", ESP: "ES", FRA: "FR", GHA: "GH", GRC: "GR", HAI: "HT", HTI: "HT",
  HND: "HN", HON: "HN", HUN: "HU", IRN: "IR", IRL: "IE", IRQ: "IQ", ISL: "IS",
  ISR: "IL", ITA: "IT", JAM: "JM", JOR: "JO", JPN: "JP", KOR: "KR", KSA: "SA",
  KWT: "KW", MAR: "MA", MOR: "MA", MEX: "MX", NED: "NL", NLD: "NL", NIR: "GB",
  NGA: "NG", NOR: "NO", NZL: "NZ", PAN: "PA", PAR: "PY", PRY: "PY", PER: "PE",
  POL: "PL", POR: "PT", PRT: "PT", QAT: "QA", ROU: "RO", RSA: "ZA", ZAF: "ZA",
  RUS: "RU", SAU: "SA", SCO: "GB", SCG: "RS", SEN: "SN", SRB: "RS", SVK: "SK",
  SVN: "SI", SLO: "SI", SLV: "SV", SUI: "CH", CHE: "CH", SUN: "RU",
  SWE: "SE", TCH: "CZ", TGO: "TG", TTO: "TT", TUN: "TN", TUR: "TR", UKR: "UA",
  URU: "UY", URY: "UY", USA: "US", UZB: "UZ", WAL: "GB", YUG: "RS", ZAI: "CD",
  CPV: "CV", CIV: "CI", AGO: "AO", ARE: "AE", ALB: "AL",
  GRE: "GR", BUL: "BG", DEN: "DK", CRC: "CR",
};

export function getFlagUrl(iso3) {
  const iso2 = (ISO3_TO_2[iso3] || iso3.slice(0, 2)).toLowerCase();
  return `/flags/${iso2}.png`;
}

// ── Contract ABI ────────────────────────────────────────────────────────────
export const FOOTMON_ABI = [
  "function owner() view returns (address)",
  "function rollPrice() view returns (uint256)",
  "function prizePoolPct() view returns (uint256)",
  "function payoutInterval() view returns (uint256)",
  "function lastPayoutTime() view returns (uint256)",
  "function prizePool() view returns (uint256)",
  "function roundNumber() view returns (uint256)",
  "function getEntriesCount() view returns (uint256)",
  "function getEntry(uint256 idx) view returns (tuple(address player, uint256 score, uint256 timestamp, string nation, uint16 year, string formation))",
  "function getTimeUntilPayout() view returns (uint256)",
  "function canDistribute() view returns (bool)",
  "function pendingClaims(address) view returns (uint256)",
  "function hasEntry(address) view returns (bool)",
  "function resolver() view returns (address)",
  "function duelHousePct() view returns (uint256)",
  "function duelExpiry() view returns (uint256)",
  "function duelsPaused() view returns (bool)",
  "function getDuel(bytes32) view returns (tuple(address creator, address joiner, uint256 stake, uint64 createdAt, uint8 status))",
  "function duelStatus(bytes32) view returns (uint8)",
  "function timeUntilDuelExpiry(bytes32) view returns (uint256)",
  "function createDuel(bytes32 duelId) payable",
  "function joinDuel(bytes32 duelId) payable",
  "function cancelDuel(bytes32 duelId)",
  "function refundExpiredDuel(bytes32 duelId)",
  "function claimDuelPrize()",
  "function payForRoll() payable",
  "function fundPrizePool() payable",

  "function submitScore(uint256 score, string nation, uint16 year, string formation)",
  "function distributePrize()",
  "function claimPrize()",
  "function setRollPrice(uint256 _price)",
  "function setPrizePoolPct(uint256 _pct)",
  "function setPayoutInterval(uint256 _interval)",
  "function transferOwnership(address newOwner)",
  "event RollPurchased(address indexed player, uint256 amount)",
  "event PrizePoolFunded(address indexed sender, uint256 amount)",

  "event ScoreSubmitted(address indexed player, uint256 score, string nation, uint16 year, string formation)",
  "event PrizeAllocated(address indexed winner, uint256 amount, uint256 round)",
  "event PrizeClaimed(address indexed winner, uint256 amount)",
  "event DuelCreated(bytes32 indexed duelId, address indexed creator, uint256 stake)",
  "event DuelJoined(bytes32 indexed duelId, address indexed joiner, uint256 stake)",
  "event DuelResolved(bytes32 indexed duelId, address indexed winner, uint256 payout, uint256 houseCut)",
  "event DuelDrawn(bytes32 indexed duelId, uint256 refundEach)",
  "event DuelCancelled(bytes32 indexed duelId, address indexed creator, uint256 refund)",
  "event DuelRefunded(bytes32 indexed duelId, string reason)",
];

export const DUEL_STATUS = {
  NONE: 0,
  OPEN: 1,
  FULL: 2,
  RESOLVED: 3,
  CANCELLED: 4,
  REFUNDED: 5,
};

// ── World Cup years ─────────────────────────────────────────────────────────
export const WC_YEARS = [1970, 1974, 1978, 1982, 1986, 1990, 1994, 1998, 2002, 2006, 2010, 2014, 2018, 2022, 2026];

// ── Helpers ─────────────────────────────────────────────────────────────────
export function canPlayerFillSlot(player, slotPos) {
  if (!player || !slotPos) return false;
  const accepted = POSITION_COMPAT[slotPos] || [slotPos];
  const positions = Array.isArray(player.positions)
    ? player.positions
    : player.position
      ? player.position.split("/")
      : [];
  return positions.some((p) => accepted.includes(p.trim().toUpperCase()));
}

export function buildSlots(formationKey, styleKey) {
  const fmn = FORMATIONS[formationKey];
  if (!fmn) return [];
  const shiftY = styleKey === "defensive" ? 4.5 : styleKey === "attacking" ? -4.5 : 0;
  const scaleX = styleKey === "defensive" ? 0.85 : styleKey === "attacking" ? 1.15 : 1.0;

  return fmn.slots.map((s, i) => {
    let newLeft = 50 + (s.left - 50) * scaleX;
    newLeft = Math.min(92, Math.max(8, newLeft));
    let newTop = s.pos === "GK" ? s.top : s.top + shiftY;
    newTop = Math.min(84, Math.max(10, newTop));

    return { pos: s.pos, top: newTop, left: newLeft, player: null, id: i };
  });
}

export function ratingColor(r) {
  if (r >= 85) return "#f0c040";
  if (r >= 80) return "#4cdf6f";
  if (r >= 70) return "#ffffff";
  return "#8a8a9a";
}

export function shortName(name) {
  if (!name) return "—";
  const parts = name.split(" ");
  if (parts.length <= 1) return name;
  return parts[0][0] + ". " + parts.slice(1).join(" ");
}
