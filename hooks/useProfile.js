"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppKitAccount, useAppKitProvider } from "@reown/appkit/react";
import { BrowserProvider } from "ethers";

/**
 * Hook for username/profile management.
 */
export function useProfile() {
  const { address, isConnected } = useAppKitAccount();
  const { walletProvider } = useAppKitProvider("eip155");

  const [username, setUsername] = useState(null);
  const [showClaimModal, setShowClaimModal] = useState(false);
  const [claimError, setClaimError] = useState("");
  const [claimBusy, setClaimBusy] = useState(false);

  const cacheRef = useRef(new Map());

  // Fetch profile on connect
  useEffect(() => {
    if (!address) {
      setUsername(null);
      return;
    }
    (async () => {
      const result = await fetchProfile(address);
      if (result.profile?.username) {
        setUsername(result.profile.username);
        cacheRef.current.set(address.toLowerCase(), result.profile.username);
      } else if (result.ok && !result.profile) {
        // No profile yet — show claim modal
        setShowClaimModal(true);
      }
    })();
  }, [address]);

  async function fetchProfile(addr) {
    try {
      const res = await fetch(`/api/profile/${addr.toLowerCase()}`, { cache: "no-store" });
      if (!res.ok) return { ok: false, profile: null };
      const { profile } = await res.json();
      return { ok: true, profile: profile || null };
    } catch {
      return { ok: false, profile: null };
    }
  }

  const claimUsername = useCallback(async (desiredUsername) => {
    if (!address || !walletProvider) return null;
    setClaimBusy(true);
    setClaimError("");

    try {
      const payload = {
        address: address.toLowerCase(),
        username: desiredUsername,
        issuedAt: new Date().toISOString(),
        nonce: randomNonce(),
      };

      const message = buildClaimMessage(payload);
      const provider = new BrowserProvider(walletProvider);
      const signer = await provider.getSigner();
      const signature = await signer.signMessage(message);

      const res = await fetch("/api/profile/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, signature }),
      });
      const json = await res.json();

      if (!res.ok) {
        setClaimError(json.details || json.error || "Could not claim username");
        return null;
      }

      const claimed = json.profile.username;
      setUsername(claimed);
      cacheRef.current.set(address.toLowerCase(), claimed);
      setShowClaimModal(false);
      return claimed;
    } catch (err) {
      const rejected = err?.code === "ACTION_REJECTED" || /reject|denied/i.test(err?.message || "");
      setClaimError(rejected ? "Signature rejected" : (err?.message || "Signing failed"));
      return null;
    } finally {
      setClaimBusy(false);
    }
  }, [address, walletProvider]);

  const dismissModal = useCallback(() => {
    setShowClaimModal(false);
  }, []);

  const usernameFor = useCallback((addr) => {
    if (!addr) return "—";
    const key = String(addr).toLowerCase();
    if (cacheRef.current.has(key)) return cacheRef.current.get(key);
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  }, []);

  const prefetch = useCallback(async (addresses) => {
    const missing = [...new Set(
      (addresses || []).filter(Boolean).map((a) => a.toLowerCase())
        .filter((a) => !cacheRef.current.has(a))
    )];
    if (missing.length === 0) return;
    try {
      const res = await fetch(`/api/profile?addresses=${missing.join(",")}`, { cache: "no-store" });
      if (!res.ok) return;
      const { usernames } = await res.json();
      for (const a of missing) {
        if (usernames[a]) cacheRef.current.set(a, usernames[a]);
      }
    } catch { /* fallback to short addresses */ }
  }, []);

  return {
    username,
    showClaimModal,
    claimError,
    claimBusy,
    claimUsername,
    dismissModal,
    setClaimError,
    usernameFor,
    prefetch,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function buildClaimMessage({ address, username, issuedAt, nonce }) {
  return [
    "FootMon username claim",
    "",
    `Address: ${String(address).toLowerCase()}`,
    `Username: ${username}`,
    `Issued At: ${issuedAt}`,
    `Nonce: ${nonce}`,
    "",
    "Signing proves you control this wallet.",
    "It costs no gas and sends no transaction.",
  ].join("\n");
}
