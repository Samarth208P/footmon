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
  // ── Duel escrow: view ─────────────────────────────────────────
  "function resolver() view returns (address)",
  "function duelHousePct() view returns (uint256)",
  "function duelExpiry() view returns (uint256)",
  "function duelsPaused() view returns (bool)",
  "function getDuel(bytes32) view returns (tuple(address creator, address joiner, uint256 stake, uint64 createdAt, uint8 status))",
  "function duelStatus(bytes32) view returns (uint8)",
  "function timeUntilDuelExpiry(bytes32) view returns (uint256)",
  // ── Duel escrow: write ────────────────────────────────────────
  "function createDuel(bytes32 duelId) payable",
  "function joinDuel(bytes32 duelId) payable",
  "function cancelDuel(bytes32 duelId)",
  "function refundExpiredDuel(bytes32 duelId)",
  "function claimDuelPrize()",
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
  "event DuelCreated(bytes32 indexed duelId, address indexed creator, uint256 stake)",
  "event DuelJoined(bytes32 indexed duelId, address indexed joiner, uint256 stake)",
  "event DuelResolved(bytes32 indexed duelId, address indexed winner, uint256 payout, uint256 houseCut)",
  "event DuelDrawn(bytes32 indexed duelId, uint256 refundEach)",
  "event DuelCancelled(bytes32 indexed duelId, address indexed creator, uint256 refund)",
  "event DuelRefunded(bytes32 indexed duelId, string reason)",
];

/** Mirrors the DuelStatus enum in contract/FootMon.sol. */
const DUEL_STATUS = {
  NONE: 0,
  OPEN: 1,
  FULL: 2,
  RESOLVED: 3,
  CANCELLED: 4,
  REFUNDED: 5,
};

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
  /**
   * Pay for one roll.
   *
   * `amountMon` lets the client charge more than the contract's minimum
   * (`rollPrice`), which is how the 0.01 MON reroll works without an owner
   * transaction: payForRoll only requires msg.value >= rollPrice, and
   * prizePoolPct of whatever is sent goes to the hourly prize pool.
   */
  async function payForRoll(amountMon) {
    if (!isAvailable()) throw new Error("Connect wallet first");
    const minimum = await readContract.rollPrice();

    let value = minimum;
    if (amountMon !== undefined && amountMon !== null) {
      const requested = ethers.parseEther(String(amountMon));
      // Never send less than the contract demands, or the call reverts.
      value = requested > minimum ? requested : minimum;
    }

    const tx = await contract.payForRoll({ value });
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

  // ══════════════════════════════════════════════════════════════════════════
  //  Duel escrow
  //
  //  Stakes are held by the contract, not sent peer-to-peer. Each of these is a
  //  single MetaMask confirmation.
  // ══════════════════════════════════════════════════════════════════════════

  /** Random bytes32 duel id, generated client-side and reused on-chain and off. */
  function newDuelId() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function requireSigner() {
    if (!isAvailable() || !contract) throw new Error("Connect your wallet first");
    return contract;
  }

  /** Escrows the creator's stake and opens the duel. */
  async function createDuel(duelId, stakeMon) {
    const c = requireSigner();
    const value = ethers.parseEther(String(stakeMon));
    if (value <= 0n) throw new Error("Stake must be greater than zero");

    const tx = await c.createDuel(duelId, { value });
    const receipt = await tx.wait();
    return { txHash: receipt?.hash ?? tx.hash, stakeWei: value.toString() };
  }

  /** Matches the creator's stake exactly, read from the chain. */
  async function joinDuel(duelId) {
    const c = requireSigner();
    const duel = await getDuel(duelId);

    if (Number(duel.status) !== DUEL_STATUS.OPEN) {
      throw new Error("This duel is no longer open on-chain");
    }

    const tx = await c.joinDuel(duelId, { value: duel.stake });
    const receipt = await tx.wait();
    return { txHash: receipt?.hash ?? tx.hash, stakeWei: duel.stake.toString() };
  }

  /** Creator reclaims their stake before anyone joins. */
  async function cancelDuel(duelId) {
    const c = requireSigner();
    const tx = await c.cancelDuel(duelId);
    const receipt = await tx.wait();
    return receipt?.hash ?? tx.hash;
  }

  /** Permissionless timeout reclaim, so stakes can never be stranded. */
  async function refundExpiredDuel(duelId) {
    const c = requireSigner();
    const tx = await c.refundExpiredDuel(duelId);
    const receipt = await tx.wait();
    return receipt?.hash ?? tx.hash;
  }

  /** Winner pulls their escrowed winnings. */
  async function claimDuelPrize() {
    const c = requireSigner();
    const tx = await c.claimDuelPrize();
    const receipt = await tx.wait();
    return receipt?.hash ?? tx.hash;
  }

  async function getDuel(duelId) {
    const rc = readContract || contract;
    if (!rc) throw new Error("Contract is not configured");
    return rc.getDuel(duelId);
  }

  async function getDuelStatus(duelId) {
    const rc = readContract || contract;
    if (!rc) return DUEL_STATUS.NONE;
    return Number(await rc.duelStatus(duelId));
  }

  async function getPendingClaim(address) {
    const rc = readContract || contract;
    if (!rc) return 0n;
    return rc.pendingClaims(address);
  }

  async function getDuelHousePct() {
    const rc = readContract || contract;
    if (!rc) return 30n;
    return rc.duelHousePct();
  }

  return {
    init, isAvailable,
    payForRoll, submitScore, distributePrize, claimPrize,
    getPrizePool, getTimeUntilPayout, canDistribute, getPendingClaim,
    getLeaderboard, getRollPrice, getPayoutInterval, getRoundNumber,
    // Duel escrow
    newDuelId, createDuel, joinDuel, cancelDuel, refundExpiredDuel,
    claimDuelPrize, getDuel, getDuelStatus, getDuelHousePct,
    DUEL_STATUS,
  };
})();
