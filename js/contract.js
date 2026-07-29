// js/contract.js — FootMon smart contract interactions

const FOOTMON_ABI = [
  // ── View ──────────────────────────────────────────────────────
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
  // ── Write ─────────────────────────────────────────────────────
  "function payForRoll() payable",
  "function submitScore(uint256 score, string nation, uint16 year, string formation)",
  "function distributePrize()",
  "function claimPrize()",
  // ── Owner ─────────────────────────────────────────────────────
  "function setRollPrice(uint256 _price)",
  "function setPrizePoolPct(uint256 _pct)",
  "function setPayoutInterval(uint256 _interval)",
  "function transferOwnership(address newOwner)",
  // ── Events ────────────────────────────────────────────────────
  "event RollPurchased(address indexed player, uint256 amount)",
  "event ScoreSubmitted(address indexed player, uint256 score, string nation, uint16 year, string formation)",
  "event PrizeAllocated(address indexed winner, uint256 amount, uint256 round)",
  "event PrizeClaimed(address indexed winner, uint256 amount)",
];

const ContractManager = (() => {
  let contract     = null;
  let readContract = null;   // provider-only instance for reads (no signer needed)

  function isAvailable() {
    return CONTRACT_ADDRESS !== null && WalletManager.isConnected();
  }

  function init() {
    if (!CONTRACT_ADDRESS) return;

    const provider = WalletManager.getProvider();
    const signer   = WalletManager.getSigner();

    if (signer) {
      contract     = new ethers.Contract(CONTRACT_ADDRESS, FOOTMON_ABI, signer);
    }
    // Read-only fallback
    const rpcProvider = new ethers.JsonRpcProvider(MONAD_CHAIN.rpcUrls[0]);
    readContract = new ethers.Contract(CONTRACT_ADDRESS, FOOTMON_ABI, rpcProvider);
  }

  /** Pay for one extra roll — 0.001 MON (or whatever rollPrice is set to on-chain). */
  async function payForRoll() {
    if (!isAvailable()) throw new Error("Connect wallet first");
    const price = await readContract.rollPrice();
    const tx    = await contract.payForRoll({ value: price });
    return tx.wait();
  }

  /**
   * Submit team score on-chain.
   * @param {number} avgRating  – raw average (e.g. 82.5)
   * @param {string} nation     – ISO-3 code
   * @param {number} year       – World Cup year
   * @param {string} formation  – e.g. "4-3-3"
   */
  async function submitScore(avgRating, nation, year, formation) {
    if (!isAvailable()) throw new Error("Connect wallet first");
    const score = Math.round(avgRating * 100); // store as integer ×100
    const tx    = await contract.submitScore(score, nation, year, formation);
    return tx.wait();
  }

  /** Distribute prize if interval has elapsed. Anyone can call this. */
  async function distributePrize() {
    if (!isAvailable()) throw new Error("Connect wallet first");
    const tx = await contract.distributePrize();
    return tx.wait();
  }

  /** Claim winner's pending prize. */
  async function claimPrize() {
    if (!isAvailable()) throw new Error("Connect wallet first");
    const tx = await contract.claimPrize();
    return tx.wait();
  }

  // ── Read helpers ──────────────────────────────────────────────────────────

  async function getPrizePool() {
    const rc = readContract || contract;
    if (!rc) return 0n;
    return rc.prizePool();
  }

  async function getTimeUntilPayout() {
    const rc = readContract || contract;
    if (!rc) return 0n;
    return rc.getTimeUntilPayout();
  }

  async function canDistribute() {
    const rc = readContract || contract;
    if (!rc) return false;
    return rc.canDistribute();
  }

  async function getPendingClaim(address) {
    const rc = readContract || contract;
    if (!rc) return 0n;
    return rc.pendingClaims(address);
  }

  /**
   * Fetch all leaderboard entries from chain.
   * Returns sorted array (highest score first).
   */
  async function getLeaderboard() {
    const rc = readContract || contract;
    if (!rc) return [];

    const count = Number(await rc.getEntriesCount());
    const batch = [];
    for (let i = 0; i < count; i++) {
      batch.push(rc.getEntry(i));
    }
    const raw = await Promise.all(batch);

    const entries = raw.map(e => ({
      player:    e.player,
      score:     Number(e.score) / 100,      // back to decimal rating
      timestamp: Number(e.timestamp),
      nation:    e.nation,
      year:      Number(e.year),
      formation: e.formation,
    }));

    // Sort: highest score first; tiebreak = earliest timestamp
    entries.sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.timestamp - b.timestamp
    );

    return entries;
  }

  async function getRollPrice() {
    const rc = readContract || contract;
    if (!rc) return ethers.parseEther(ROLL_PRICE_MON);
    return rc.rollPrice();
  }

  async function getPayoutInterval() {
    const rc = readContract || contract;
    if (!rc) return 3600n;
    return rc.payoutInterval();
  }

  async function getRoundNumber() {
    const rc = readContract || contract;
    if (!rc) return 1n;
    return rc.roundNumber();
  }

  return {
    init, isAvailable,
    payForRoll, submitScore, distributePrize, claimPrize,
    getPrizePool, getTimeUntilPayout, canDistribute, getPendingClaim,
    getLeaderboard, getRollPrice, getPayoutInterval, getRoundNumber,
  };
})();
