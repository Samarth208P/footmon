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

  const signerContractRef = useRef(null);
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

  // Signer contract (available when wallet connected)
  useEffect(() => {
    if (!CONTRACT_ADDRESS || !isConnected || !walletProvider) {
      signerContractRef.current = null;
      return;
    }
    (async () => {
      try {
        const provider = new BrowserProvider(walletProvider);
        const signer = await provider.getSigner();
        signerContractRef.current = new Contract(CONTRACT_ADDRESS, FOOTMON_ABI, signer);
      } catch (err) {
        console.error("[useContract] Failed to create signer contract:", err);
      }
    })();
  }, [isConnected, walletProvider, address]);

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
    return !!CONTRACT_ADDRESS && isConnected && !!signerContractRef.current;
  }, [isConnected]);

  // ── Write functions ─────────────────────────────────────────────────────

  const payForRoll = useCallback(async (amountMon = REROLL_PRICE_MON) => {
    const c = signerContractRef.current;
    if (!c) throw new Error("Connect wallet first");
    const value = parseEther(String(amountMon));
    const tx = await c.payForRoll({ value });
    await tx.wait();
  }, []);

  const submitScore = useCallback(async (avgRating, nation, year, formation) => {
    const c = signerContractRef.current;
    if (!c) throw new Error("Connect wallet first");
    const score = Math.round(avgRating * 100);
    const tx = await c.submitScore(score, nation, year, formation);
    await tx.wait();
  }, []);

  const distributePrize = useCallback(async () => {
    const c = signerContractRef.current;
    if (!c) throw new Error("Connect wallet first");
    const tx = await c.distributePrize();
    await tx.wait();
  }, []);

  const claimPrize = useCallback(async () => {
    const c = signerContractRef.current;
    if (!c) throw new Error("Connect wallet first");
    const tx = await c.claimPrize();
    await tx.wait();
    await refreshData();
  }, [refreshData]);

  // ── Duel functions ──────────────────────────────────────────────────────

  const createDuel = useCallback(async (duelId, stakeMon) => {
    const c = signerContractRef.current;
    if (!c) throw new Error("Connect wallet first");
    const value = parseEther(String(stakeMon));
    const tx = await c.createDuel(duelId, { value });
    const receipt = await tx.wait();
    return { txHash: receipt?.hash ?? tx.hash, stakeWei: value.toString() };
  }, []);

  const joinDuel = useCallback(async (duelId) => {
    const c = signerContractRef.current;
    const rc = readContractRef.current;
    if (!c || !rc) throw new Error("Connect wallet first");
    const duel = await rc.getDuel(duelId);
    if (Number(duel.status) !== 1) throw new Error("Duel is not open");
    const tx = await c.joinDuel(duelId, { value: duel.stake });
    const receipt = await tx.wait();
    return { txHash: receipt?.hash ?? tx.hash, stakeWei: duel.stake.toString() };
  }, []);

  const cancelDuel = useCallback(async (duelId) => {
    const c = signerContractRef.current;
    if (!c) throw new Error("Connect wallet first");
    const tx = await c.cancelDuel(duelId);
    const receipt = await tx.wait();
    return receipt?.hash ?? tx.hash;
  }, []);

  const claimDuelPrize = useCallback(async () => {
    const c = signerContractRef.current;
    if (!c) throw new Error("Connect wallet first");
    const tx = await c.claimDuelPrize();
    await tx.wait();
    await refreshData();
  }, [refreshData]);

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
