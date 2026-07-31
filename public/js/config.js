// js/config.js
// ─────────────────────────────────────────────────────────────────
// ⚠️  After deploying FootMon.sol, paste the contract address below.
//    Leave as null to run in "wallet-only" mode (leaderboard disabled).
// ─────────────────────────────────────────────────────────────────

const CONTRACT_ADDRESS = "0xE60f79571E7EDba477ff98BAdeE618b5605DF7aE"; // e.g. "0xYourDeployedAddressHere"

const MONAD_CHAIN = {
  chainId:         "0x279F",   // 10143 decimal
  chainName:       "Monad Testnet",
  rpcUrls:         ["https://testnet-rpc.monad.xyz"],
  nativeCurrency:  { name: "MON", symbol: "MON", decimals: 18 },
  blockExplorerUrls: ["https://explorer.testnet.monad.xyz"],
};

const FREE_ROLLS     = 4;
const ROLL_PRICE_MON = "0.001"; // MON

// ─── Position Compatibility ──────────────────────────────────────────────────
// POSITION_COMPAT[slotPos] = array of player position strings from CSV that can fill slotPos
const POSITION_COMPAT = {
  GK:  ["GK"],
  CB:  ["CB"],
  LB:  ["LB", "LWB"],
  RB:  ["RB", "RWB"],
  CM:  ["CM", "DM", "AM", "CDM", "CAM"],
  LM:  ["LM"],
  RM:  ["RM"],
  ST:  ["ST", "CF", "SS"],
  LW:  ["LW"],
  RW:  ["RW"],
  CF:  ["CF", "ST", "SS"],
};

// ─── Formations ──────────────────────────────────────────────────────────────
// Coordinates are % of pitch container (top-left origin).
// top=0 → opponent goal, top=100 → our goal (GK near bottom).
// Defensive style: +4 to all non-GK tops. Attacking: -4.

const FORMATIONS = {
  "4-3-3": {
    label: "4-3-3",
    slots: [
      { pos: "GK",  top: 86, left: 50 },
      { pos: "LB",  top: 70, left: 14 },
      { pos: "CB",  top: 71, left: 35 },
      { pos: "CB",  top: 71, left: 65 },
      { pos: "RB",  top: 70, left: 86 },
      { pos: "CM",  top: 51, left: 26 },
      { pos: "CM",  top: 50, left: 50 },
      { pos: "CM",  top: 51, left: 74 },
      { pos: "LW",  top: 23, left: 14 },
      { pos: "ST",  top: 17, left: 50 },
      { pos: "RW",  top: 23, left: 86 },
    ],
  },
  "4-4-2": {
    label: "4-4-2",
    slots: [
      { pos: "GK",  top: 86, left: 50 },
      { pos: "LB",  top: 70, left: 14 },
      { pos: "CB",  top: 71, left: 35 },
      { pos: "CB",  top: 71, left: 65 },
      { pos: "RB",  top: 70, left: 86 },
      { pos: "LM",  top: 50, left: 12 },
      { pos: "CM",  top: 51, left: 35 },
      { pos: "CM",  top: 51, left: 65 },
      { pos: "RM",  top: 50, left: 88 },
      { pos: "ST",  top: 18, left: 35 },
      { pos: "ST",  top: 18, left: 65 },
    ],
  },
  "4-2-3-1": {
    label: "4-2-3-1",
    slots: [
      { pos: "GK",  top: 86, left: 50 },
      { pos: "LB",  top: 70, left: 14 },
      { pos: "CB",  top: 71, left: 35 },
      { pos: "CB",  top: 71, left: 65 },
      { pos: "RB",  top: 70, left: 86 },
      { pos: "CM",  top: 58, left: 37 },
      { pos: "CM",  top: 58, left: 63 },
      { pos: "LM",  top: 40, left: 14 },
      { pos: "CM",  top: 39, left: 50 },
      { pos: "RM",  top: 40, left: 86 },
      { pos: "ST",  top: 18, left: 50 },
    ],
  },
  "4-2-4": {
    label: "4-2-4",
    slots: [
      { pos: "GK",  top: 86, left: 50 },
      { pos: "LB",  top: 70, left: 14 },
      { pos: "CB",  top: 71, left: 35 },
      { pos: "CB",  top: 71, left: 65 },
      { pos: "RB",  top: 70, left: 86 },
      { pos: "CM",  top: 51, left: 37 },
      { pos: "CM",  top: 51, left: 63 },
      { pos: "LW",  top: 18, left: 12 },
      { pos: "ST",  top: 16, left: 37 },
      { pos: "ST",  top: 16, left: 63 },
      { pos: "RW",  top: 18, left: 88 },
    ],
  },
  "3-5-2": {
    label: "3-5-2",
    slots: [
      { pos: "GK",  top: 86, left: 50 },
      { pos: "CB",  top: 71, left: 24 },
      { pos: "CB",  top: 70, left: 50 },
      { pos: "CB",  top: 71, left: 76 },
      { pos: "LM",  top: 50, left: 10 },
      { pos: "CM",  top: 51, left: 31 },
      { pos: "CM",  top: 53, left: 50 },
      { pos: "CM",  top: 51, left: 69 },
      { pos: "RM",  top: 50, left: 90 },
      { pos: "ST",  top: 18, left: 35 },
      { pos: "ST",  top: 18, left: 65 },
    ],
  },
  "5-3-2": {
    label: "5-3-2",
    slots: [
      { pos: "GK",  top: 86, left: 50 },
      { pos: "LB",  top: 72, left: 8 },
      { pos: "CB",  top: 70, left: 26 },
      { pos: "CB",  top: 69, left: 50 },
      { pos: "CB",  top: 70, left: 74 },
      { pos: "RB",  top: 72, left: 92 },
      { pos: "CM",  top: 50, left: 28 },
      { pos: "CM",  top: 49, left: 50 },
      { pos: "CM",  top: 50, left: 72 },
      { pos: "ST",  top: 18, left: 35 },
      { pos: "ST",  top: 18, left: 65 },
    ],
  },
  "4-5-1": {
    label: "4-5-1",
    slots: [
      { pos: "GK",  top: 86, left: 50 },
      { pos: "LB",  top: 70, left: 14 },
      { pos: "CB",  top: 71, left: 35 },
      { pos: "CB",  top: 71, left: 65 },
      { pos: "RB",  top: 70, left: 86 },
      { pos: "LM",  top: 50, left: 10 },
      { pos: "CM",  top: 51, left: 28 },
      { pos: "CM",  top: 53, left: 50 },
      { pos: "CM",  top: 51, left: 72 },
      { pos: "RM",  top: 50, left: 90 },
      { pos: "ST",  top: 18, left: 50 },
    ],
  },
  "3-4-3": {
    label: "3-4-3",
    slots: [
      { pos: "GK",  top: 86, left: 50 },
      { pos: "CB",  top: 71, left: 24 },
      { pos: "CB",  top: 70, left: 50 },
      { pos: "CB",  top: 71, left: 76 },
      { pos: "LM",  top: 51, left: 16 },
      { pos: "CM",  top: 50, left: 38 },
      { pos: "CM",  top: 50, left: 62 },
      { pos: "RM",  top: 51, left: 84 },
      { pos: "LW",  top: 19, left: 14 },
      { pos: "ST",  top: 16, left: 50 },
      { pos: "RW",  top: 19, left: 86 },
    ],
  },
};

const STYLE_OFFSET = { defensive: 4, balanced: 0, attacking: -4 };

// ─── ISO-3 → ISO-2 flag mapping ─────────────────────────────────────────────
const ISO3_TO_2 = {
  ARG:"AR", AUS:"AU", AUT:"AT", BEL:"BE", BIH:"BA", BOL:"BO", BRA:"BR",
  BGR:"BG", CAN:"CA", CHL:"CL", CHI:"CL", CHN:"CN", CMR:"CM", COD:"CD",
  COL:"CO", CRI:"CR", CRO:"HR", HRV:"HR", CSK:"CZ", CUW:"CW", CZE:"CZ",
  DDR:"DE", DEU:"DE", GER:"DE", DZA:"DZ", ALG:"DZ", ECU:"EC", EGY:"EG",
  ENG:"GB", ESP:"ES", FRA:"FR", GHA:"GH", GRC:"GR", HAI:"HT", HTI:"HT",
  HND:"HN", HON:"HN", HUN:"HU", IRN:"IR", IRL:"IE", IRQ:"IQ", ISL:"IS",
  ISR:"IL", ITA:"IT", JAM:"JM", JOR:"JO", JPN:"JP", KOR:"KR", KSA:"SA",
  KWT:"KW", MAR:"MA", MOR:"MA", MEX:"MX", NED:"NL", NLD:"NL", NIR:"GB",
  NGA:"NG", NOR:"NO", NZL:"NZ", PAN:"PA", PAR:"PY", PRY:"PY", PER:"PE",
  POL:"PL", POR:"PT", PRT:"PT", QAT:"QA", ROU:"RO", RSA:"ZA", ZAF:"ZA",
  RUS:"RU", SAU:"SA", SCO:"GB", SCG:"RS", SEN:"SN", SRB:"RS", SVK:"SK",
  SVN:"SI", SLO:"SI", SLV:"SV", SUI:"CH", CHE:"CH", SUN:"RU",
  SWE:"SE", TCH:"CZ", TGO:"TG", TTO:"TT", TUN:"TN", TUR:"TR", UKR:"UA",
  URU:"UY", URY:"UY", USA:"US", UZB:"UZ", WAL:"GB", YUG:"RS", ZAI:"CD",
  CPV:"CV", CIV:"CI", AGO:"AO", ARE:"AE", ALB:"AL",
  SCO:"GB", GRE:"GR", BUL:"BG",
  // 2026 specific
  RSA:"ZA", CUW:"CW", GER:"DE", NED:"NL", KSA:"SA",
  ESP:"ES", URU:"UY", FRA:"FR", IRQ:"IQ", NOR:"NO",
  SEN:"SN", ALG:"DZ", AUT:"AT", JOR:"JO",
  COD:"CD", POR:"PT", UZB:"UZ", CRO:"HR", ENG:"GB", GHA:"GH",
};

function getFlagEmoji(iso3) {
  const iso2 = ISO3_TO_2[iso3] || iso3.slice(0, 2);
  if (iso2.length !== 2) return "🏳️";
  return [...iso2.toUpperCase()].map(c =>
    String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)
  ).join("");
}

// Available World Cup years
const WC_YEARS = [1970,1974,1978,1982,1986,1990,1994,1998,2002,2006,2010,2014,2018,2022,2026];
