import { Contract, JsonRpcProvider, Wallet } from "ethers";

/**
 * Server-side view of the FootMon escrow contract.
 *
 * The server never takes a client's word for who staked what. Room records are
 * only bookkeeping; the contract is the source of truth for money. Every
 * create/join is validated against on-chain state before it is accepted.
 */

export const DUEL_STATUS = {
  NONE: 0,
  OPEN: 1,
  FULL: 2,
  RESOLVED: 3,
  CANCELLED: 4,
  REFUNDED: 5,
};

export const FOOTMON_DUEL_ABI = [
  "function resolver() view returns (address)",
  "function owner() view returns (address)",
  "function duelHousePct() view returns (uint256)",
  "function duelExpiry() view returns (uint256)",
  "function duelsPaused() view returns (bool)",
  "function pendingClaims(address) view returns (uint256)",
  "function totalEscrowed() view returns (uint256)",
  "function getDuel(bytes32) view returns (tuple(address creator, address joiner, uint256 stake, uint64 createdAt, uint8 status))",
  "function duelStatus(bytes32) view returns (uint8)",
  "function resolveDuel(bytes32 duelId, address winner)",
  "function resolveDuelDraw(bytes32 duelId)",
  "function refundExpiredDuel(bytes32 duelId)",
  // Player-facing. Present so tests and scripts can drive a full duel; the
  // server itself never signs these (it only ever holds the resolver key).
  "function createDuel(bytes32 duelId) payable",
  "function joinDuel(bytes32 duelId) payable",
  "function cancelDuel(bytes32 duelId)",
  "function claimDuelPrize()",
];

function rpcUrl() {
  return process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz";
}

function contractAddress() {
  const addr = process.env.CONTRACT_ADDRESS || "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error("[FootMon] CONTRACT_ADDRESS is not set to a valid address");
  }
  return addr;
}

export function isChainConfigured() {
  return /^0x[0-9a-fA-F]{40}$/.test(process.env.CONTRACT_ADDRESS || "");
}

export function isResolverConfigured() {
  return /^0x[0-9a-fA-F]{64}$/.test(process.env.RESOLVER_PRIVATE_KEY || "");
}

let provider = null;

export function getProvider() {
  if (!provider) {
    // staticNetwork avoids a chainId round trip on every call.
    provider = new JsonRpcProvider(rpcUrl(), undefined, { staticNetwork: true });
  }
  return provider;
}

/** Read-only contract handle. */
export function getContract() {
  return new Contract(contractAddress(), FOOTMON_DUEL_ABI, getProvider());
}

/**
 * Contract handle signed by the resolver. Only ever used for resolveDuel /
 * resolveDuelDraw / refundExpiredDuel — the resolver has no other powers.
 */
export function getResolverContract() {
  const key = process.env.RESOLVER_PRIVATE_KEY || "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("[FootMon] RESOLVER_PRIVATE_KEY is missing or malformed");
  }
  return new Contract(contractAddress(), FOOTMON_DUEL_ABI, new Wallet(key, getProvider()));
}

/**
 * Reads a duel from the chain.
 * @returns {Promise<{creator: string, joiner: string, stake: bigint, createdAt: number, status: number}>}
 */
export async function readDuel(duelId) {
  const duel = await getContract().getDuel(duelId);
  return {
    creator: String(duel.creator).toLowerCase(),
    joiner: String(duel.joiner).toLowerCase(),
    stake: BigInt(duel.stake),
    createdAt: Number(duel.createdAt),
    status: Number(duel.status),
  };
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function isZeroAddress(address) {
  return String(address ?? "").toLowerCase() === ZERO;
}

/**
 * Confirms a duel is escrowed on-chain and open, created by `creator`.
 * @returns {Promise<{ok: true, stake: bigint} | {ok: false, error: string}>}
 */
export async function verifyDuelOpen(duelId, creator) {
  let duel;
  try {
    duel = await readDuel(duelId);
  } catch (err) {
    return { ok: false, error: `Could not read duel from chain: ${err.message}` };
  }

  if (duel.status === DUEL_STATUS.NONE) {
    return { ok: false, error: "No such duel is escrowed on-chain" };
  }
  if (duel.status !== DUEL_STATUS.OPEN) {
    return { ok: false, error: "Duel is not open on-chain" };
  }
  if (duel.creator !== String(creator).toLowerCase()) {
    return { ok: false, error: "On-chain creator does not match" };
  }
  if (duel.stake <= 0n) {
    return { ok: false, error: "Duel has no stake escrowed" };
  }
  return { ok: true, stake: duel.stake };
}

/**
 * Confirms both stakes are escrowed and `joiner` is the on-chain joiner.
 * @returns {Promise<{ok: true, stake: bigint} | {ok: false, error: string}>}
 */
export async function verifyDuelJoined(duelId, joiner) {
  let duel;
  try {
    duel = await readDuel(duelId);
  } catch (err) {
    return { ok: false, error: `Could not read duel from chain: ${err.message}` };
  }

  if (duel.status !== DUEL_STATUS.FULL) {
    return { ok: false, error: "Both stakes are not escrowed on-chain yet" };
  }
  if (duel.joiner !== String(joiner).toLowerCase()) {
    return { ok: false, error: "On-chain joiner does not match" };
  }
  return { ok: true, stake: duel.stake };
}
