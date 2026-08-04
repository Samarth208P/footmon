"use client";

import { useCallback, useEffect, useState } from "react";
import { Contract, BrowserProvider, parseEther } from "ethers";
import { useAppKitAccount, useAppKitProvider } from "@reown/appkit/react";
import { CONTRACT_ADDRESS, FOOTMON_ABI, CREDIT_PRIZE_CONTRIBUTION_MON } from "@/lib/constants";


/**
 * Bundle definitions — must match /api/credits/purchase/route.js.
 */
export const REROLL_BUNDLES = [
  { id: "starter",  label: "Starter",  rerolls: 20,   priceMon: "0.200", discount: 0   },
  { id: "value",    label: "Value",    rerolls: 30,   priceMon: "0.270", discount: 10  },
  { id: "pro",      label: "Pro",      rerolls: 50,   priceMon: "0.425", discount: 15  },
  { id: "elite",    label: "Elite",    rerolls: 100,  priceMon: "0.800", discount: 20  },
  { id: "champion", label: "Champion", rerolls: 500,  priceMon: "3.750", discount: 25  },
  { id: "legend",   label: "Legend",   rerolls: 1000, priceMon: "7.000", discount: 30  },
];

/**
 * Hook for managing reroll credits.
 *
 * - `credits`        current balance (0 if wallet not connected or none bought)
 * - `buyBundle(id)`  sends MON to contract, notifies server, refreshes balance
 * - `spendCredit()`  signs a tiny off-chain message (zero gas), hits /api/credits/spend
 *                    returns true if a credit was consumed, false if balance was 0
 * - `refetch()`      manually re-fetch balance from server
 * - `buying`         true while a bundle purchase is in-flight
 * - `spending`       true while a spend request is in-flight
 */
export function useRerollCredits(contract, showToast) {
  const { address, isConnected } = useAppKitAccount();
  const { walletProvider } = useAppKitProvider("eip155");

  const [credits, setCredits] = useState(0);
  const [buying, setBuying] = useState(false);
  const [spending, setSpending] = useState(false);

  // ── Fetch balance ──────────────────────────────────────────────────────

  const refetch = useCallback(async () => {
    if (!address) { setCredits(0); return; }
    try {
      const res = await fetch(`/api/credits/balance?wallet=${address.toLowerCase()}`);
      if (res.ok) {
        const data = await res.json();
        setCredits(data.credits ?? 0);
      }
    } catch (err) {
      console.warn("[useRerollCredits] Failed to fetch balance:", err);
    }
  }, [address]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // ── Get signer for off-chain signing ───────────────────────────────────

  const getSigner = useCallback(async () => {
    if (walletProvider) {
      const provider = new BrowserProvider(walletProvider);
      return provider.getSigner();
    }
    if (typeof window !== "undefined") {
      if (window.__APPKIT_SIGNER__) return window.__APPKIT_SIGNER__;
      if (window.ethereum) {
        const provider = new BrowserProvider(window.ethereum);
        return provider.getSigner();
      }
    }
    throw new Error("Wallet not connected");
  }, [walletProvider]);

  // ── Buy a bundle ───────────────────────────────────────────────────────

  const buyBundle = useCallback(async (bundleId) => {
    const bundle = REROLL_BUNDLES.find((b) => b.id === bundleId);
    if (!bundle) throw new Error(`Unknown bundle: ${bundleId}`);
    if (!isConnected) throw new Error("Wallet not connected");
    if (!contract?.buyRerollCredits) throw new Error("Contract not available");

    setBuying(true);
    try {
      // Single wallet popup — send bundle price to contract
      const signer = await getSigner();
      const c = new Contract(CONTRACT_ADDRESS, FOOTMON_ABI, signer);
      const value = parseEther(bundle.priceMon);
      const tx = await c.buyRerollCredits({ value });

      // Show immediate feedback
      showToast?.(`Processing ${bundle.rerolls} rerolls purchase…`, "info");

      // Wait for 1 confirmation before crediting (prevents double-spend on reorg)
      const receipt = await tx.wait(1);
      const txHash = receipt?.hash ?? tx.hash;

      // Notify server to credit the wallet
      const res = await fetch("/api/credits/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: address.toLowerCase(),
          txHash,
          bundleId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to record purchase");

      await refetch();
      showToast?.(
        `✅ ${bundle.rerolls} reroll credits added! Balance: ${data.total_credits}`,
        "success"
      );
      return { success: true, credits_added: bundle.rerolls };
    } catch (err) {
      let msg = err.message || "Purchase failed";
      if (msg.includes("ACTION_REJECTED") || msg.includes("user rejected")) msg = "Transaction cancelled";
      else if (msg.includes("insufficient funds")) msg = "Insufficient MON balance";
      showToast?.(msg, "error");
      throw err;
    } finally {
      setBuying(false);
    }
  }, [address, isConnected, contract, getSigner, refetch, showToast]);

  // ── Spend 1 credit ─────────────────────────────────────────────────────

  /**
   * Signs a tiny off-chain message (no gas, no popup) and asks the server
   * to deduct 1 credit.
   *
   * @returns {Promise<boolean>} true = credit spent, false = no credits left
   */
  const spendCredit = useCallback(async () => {
    if (!address || credits <= 0) return false;
    setSpending(true);
    try {
      const signer = await getSigner();
      const timestamp = Date.now();
      const message = `footmon-reroll:${timestamp}`;
      // eth_sign — instant, zero gas, no popup needed
      const signature = await signer.signMessage(message);

      const res = await fetch("/api/credits/spend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: address.toLowerCase(),
          signature,
          timestamp,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) return false;

      // Optimistically decrement local state
      setCredits((c) => Math.max(0, c - 1));
      return true;
    } catch (err) {
      console.warn("[useRerollCredits] spendCredit error:", err);
      return false;
    } finally {
      setSpending(false);
    }
  }, [address, credits, getSigner]);

  return {
    credits,
    buying,
    spending,
    buyBundle,
    spendCredit,
    refetch,
    bundles: REROLL_BUNDLES,
  };
}
