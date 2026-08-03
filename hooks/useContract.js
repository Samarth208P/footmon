"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Contract, JsonRpcProvider, parseEther, formatEther } from "ethers";
import { useAppKitAccount, useAppKitProvider } from "@reown/appkit/react";
import { BrowserProvider } from "ethers";
import { CONTRACT_ADDRESS, FOOTMON_ABI, MONAD_CHAIN, REROLL_PRICE_MON } from "@/lib/constants";

/**
 * Hook providing all smart contract interactions.
 * Automatically initializes when wallet connects.
 */
export function useContract() {
  const { address, isConnected } = useAppKitAccount();
  const { walletProvider } = useAppKitProvider("eip155");

  const [prizePool, setPrizePool] = useState("0");
  const [timeUntilPayout, setTimeUntilPayout] = useState(0);
  const [roundNumber, setRoundNumber] = useState(1);
  const [pendingClaim, setPendingClaim] = useState("0");

  const readContractRef = useRef(null);

  // Read-only contract (always available via public RPC)
  useEffect(() => {
    if (!CONTRACT_ADDRESS) return;
    try {
      const rpc = new JsonRpcProvider(MONAD_CHAIN.rpcUrls[0]);
      readContractRef.current = new Contract(CONTRACT_ADDRESS, FOOTMON_ABI, rpc);
    } catch (err) {
      console.error("[useContract] Failed to create read contract:", err);
    }
  }, []);

  const getSignerContract = useCallback(async () => {
    // 1. Try React AppKit state
    if (CONTRACT_ADDRESS && isConnected && walletProvider) {
      try {
        const provider = new BrowserProvider(walletProvider);
        const signer = await provider.getSigner();
        return new Contract(CONTRACT_ADDRESS, FOOTMON_ABI, signer);
      } catch (err) {
        console.warn("[useContract] Failed to create contract from walletProvider, trying fallback...", err);
      }
    }

    // 2. Try global window fallback (synced by Web3Modal provider)
    if (typeof window !== "undefined" && window.__APPKIT_SIGNER__ && CONTRACT_ADDRESS) {
      return new Contract(CONTRACT_ADDRESS, FOOTMON_ABI, window.__APPKIT_SIGNER__);
    }

    // 3. Try window.ethereum direct fallback (EIP-1193)
    if (typeof window !== "undefined" && window.ethereum && CONTRACT_ADDRESS && isConnected) {
      try {
        const provider = new BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();
        return new Contract(CONTRACT_ADDRESS, FOOTMON_ABI, signer);
      } catch (err) {
        console.warn("[useContract] Failed to create contract from window.ethereum...", err);
      }
    }

    throw new Error("Wallet not connected or contract unavailable");
  }, [isConnected, walletProvider]);

  // Refresh prize pool data periodically
  const refreshData = useCallback(async () => {
    const rc = readContractRef.current;
    if (!rc) return;
    try {
      const [pool, time, round] = await Promise.all([
        rc.prizePool(),
        rc.getTimeUntilPayout(),
        rc.roundNumber(),
      ]);
      setPrizePool(formatEther(pool));
      setTimeUntilPayout(Number(time));
      setRoundNumber(Number(round));

      if (address) {
        const claim = await rc.pendingClaims(address);
        setPendingClaim(formatEther(claim));
      }
    } catch {
      // Silent — contract might not be deployed yet
    }
  }, [address]);

  useEffect(() => {
    refreshData();
    const interval = setInterval(refreshData, 30000);
    return () => clearInterval(interval);
  }, [refreshData]);

  const isAvailable = useCallback(() => {
    const hasGlobalSigner = typeof window !== "undefined" && !!window.__APPKIT_SIGNER__;
    const hasInjected = typeof window !== "undefined" && !!window.ethereum;
    return !!CONTRACT_ADDRESS && isConnected && (!!walletProvider || hasGlobalSigner || hasInjected);
  }, [isConnected, walletProvider]);

  // ── Write functions ─────────────────────────────────────────────────────

  const payForRoll = useCallback(async (amountMon = REROLL_PRICE_MON) => {
    const c = await getSignerContract();
    const value = parseEther(String(amountMon));
    const tx = await c.payForRoll({ value });
    await tx.wait();
  }, [getSignerContract]);

  const submitScore = useCallback(async (avgRating, nation, year, formation) => {
    const c = await getSignerContract();
    const score = Math.round(avgRating * 100);
    const tx = await c.submitScore(score, nation, year, formation);
    await tx.wait();
  }, [getSignerContract]);

  const distributePrize = useCallback(async () => {
    const c = await getSignerContract();
    const tx = await c.distributePrize();
    await tx.wait();
  }, [getSignerContract]);

  const claimPrize = useCallback(async () => {
    const c = await getSignerContract();
    const tx = await c.claimPrize();
    await tx.wait();
    await refreshData();
  }, [getSignerContract, refreshData]);

  // ── Duel functions ──────────────────────────────────────────────────────

  const createDuel = useCallback(async (duelId, stakeMon) => {
    const c = await getSignerContract();
    const rc = readContractRef.current;
    if (!rc) throw new Error("Contract unavailable");

    // Idempotent: if we already escrowed (duel exists on-chain), skip the tx.
    // This handles the retry case where the tx succeeded but /ready failed.
    try {
      const duel = await rc.getDuel(duelId);
      const status = Number(duel.status);
      if (status === 1 || status === 2) {
        // Already created (OPEN) or both sides in (FULL) — no need to tx again.
        return { txHash: null, stakeWei: duel.stake.toString(), alreadyEscrowed: true };
      }
    } catch (err) {
      // getDuel failed — proceed with the create attempt.
    }

    const value = parseEther(String(stakeMon));
    const tx = await c.createDuel(duelId, { value });
    const receipt = await tx.wait();
    return { txHash: receipt?.hash ?? tx.hash, stakeWei: value.toString() };
  }, [getSignerContract]);

  const joinDuel = useCallback(async (duelId) => {
    const c = await getSignerContract();
    const rc = readContractRef.current;
    if (!rc) throw new Error("Contract unavailable");
    const duel = await rc.getDuel(duelId);
    const status = Number(duel.status);

    // Idempotent: if both sides already escrowed (FULL), skip the tx.
    // This handles the retry case where joinDuel succeeded but /ready failed.
    if (status === 2) {
      return { txHash: null, stakeWei: duel.stake.toString(), alreadyEscrowed: true };
    }
    if (status !== 1) throw new Error("Duel is not open");

    const tx = await c.joinDuel(duelId, { value: duel.stake });
    const receipt = await tx.wait();
    return { txHash: receipt?.hash ?? tx.hash, stakeWei: duel.stake.toString() };
  }, [getSignerContract]);

  const cancelDuel = useCallback(async (duelId) => {
    const c = await getSignerContract();
    const tx = await c.cancelDuel(duelId);
    const receipt = await tx.wait();
    return receipt?.hash ?? tx.hash;
  }, [getSignerContract]);

  const claimDuelPrize = useCallback(async () => {
    const c = await getSignerContract();
    const tx = await c.claimDuelPrize();
    await tx.wait();
    await refreshData();
  }, [getSignerContract, refreshData]);

  // ── Read helpers ────────────────────────────────────────────────────────

  const getLeaderboard = useCallback(async () => {
    const rc = readContractRef.current;
    if (!rc) return [];
    const count = Number(await rc.getEntriesCount());
    const batch = [];
    for (let i = 0; i < count; i++) batch.push(rc.getEntry(i));
    const raw = await Promise.all(batch);
    const entries = raw.map((e) => ({
      player: e.player,
      score: Number(e.score) / 100,
      timestamp: Number(e.timestamp),
      nation: e.nation,
      year: Number(e.year),
      formation: e.formation,
    }));
    entries.sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.timestamp - b.timestamp
    );
    return entries;
  }, []);

  const canDistribute = useCallback(async () => {
    const rc = readContractRef.current;
    if (!rc) return false;
    return rc.canDistribute();
  }, []);

  return {
    isAvailable,
    prizePool,
    timeUntilPayout,
    roundNumber,
    pendingClaim,
    refreshData,
    payForRoll,
    submitScore,
    distributePrize,
    claimPrize,
    createDuel,
    joinDuel,
    cancelDuel,
    claimDuelPrize,
    getLeaderboard,
    canDistribute,
  };
}
