"use client";

import { useEffect, useRef, useState } from "react";
import { Contract, JsonRpcProvider, formatEther } from "ethers";
import { CONTRACT_ADDRESS, FOOTMON_ABI, MONAD_CHAIN } from "@/lib/constants";

/**
 * Read-only live view of the daily prize pool.
 * Pulls prizePool + timeUntilPayout from the FootMon contract via public RPC,
 * so it works without a connected wallet. Refreshes every 30s.
 *
 * @param {"hero"|"banner"|"inline"} variant
 *   - hero:   large gradient card, for the landing page
 *   - banner: horizontal strip, for the leaderboard header
 *   - inline: tiny text pill, e.g. footer / nav
 */
export default function DailyPrizeBadge({ variant = "hero" }) {
  const [prizePool, setPrizePool] = useState(null);
  const [timeUntilPayout, setTimeUntilPayout] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const readContractRef = useRef(null);

  useEffect(() => {
    if (!CONTRACT_ADDRESS) return;
    try {
      const rpc = new JsonRpcProvider(MONAD_CHAIN.rpcUrls[0]);
      readContractRef.current = new Contract(CONTRACT_ADDRESS, FOOTMON_ABI, rpc);
    } catch {
      readContractRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const rc = readContractRef.current;
      if (!rc) return;
      try {
        const [pool, time] = await Promise.all([
          rc.prizePool(),
          rc.getTimeUntilPayout(),
        ]);
        if (cancelled) return;
        setPrizePool(formatEther(pool));
        setTimeUntilPayout(Number(time));
        setLoaded(true);
      } catch {
        // Contract might not be deployed / RPC hiccup — stay quiet.
      }
    };

    // Small delay so the RPC contract ref has a chance to initialise.
    const kickoff = setTimeout(refresh, 50);
    const interval = setInterval(refresh, 30000);
    return () => {
      cancelled = true;
      clearTimeout(kickoff);
      clearInterval(interval);
    };
  }, []);

  // Local countdown tick so the timer doesn't feel frozen between refreshes.
  useEffect(() => {
    if (timeUntilPayout == null) return;
    const t = setInterval(() => {
      setTimeUntilPayout((prev) => (prev == null || prev <= 0 ? prev : prev - 1));
    }, 1000);
    return () => clearInterval(t);
  }, [timeUntilPayout != null]);

  const prizeText = loaded && prizePool != null
    ? `${parseFloat(prizePool).toFixed(3)} MON`
    : "— MON";

  const countdown = formatCountdown(timeUntilPayout);

  if (variant === "banner") {
    return (
      <div className="daily-prize-banner">
        <span className="daily-prize-banner-icon" aria-hidden="true">💰</span>
        <div className="daily-prize-banner-text">
          <span className="daily-prize-banner-label">Today&apos;s winner takes</span>
          <span className="daily-prize-banner-amount">{prizeText}</span>
        </div>
        {countdown && (
          <span className="daily-prize-banner-timer" title="Time until next payout">
            ⏱ {countdown}
          </span>
        )}
      </div>
    );
  }

  if (variant === "inline") {
    return (
      <span className="daily-prize-inline">
        💰 Today&apos;s winner: <strong>{prizeText}</strong>
      </span>
    );
  }

  // hero (default)
  return (
    <div className="daily-prize-hero" role="status" aria-live="polite">
      <div className="daily-prize-hero-icon" aria-hidden="true">🏆</div>
      <div className="daily-prize-hero-body">
        <div className="daily-prize-hero-label">Today&apos;s Winner Takes</div>
        <div className="daily-prize-hero-amount">{prizeText}</div>
        {countdown && (
          <div className="daily-prize-hero-timer">Payout in {countdown}</div>
        )}
      </div>
    </div>
  );
}

/** Format seconds as `Hh Mm` or `Mm Ss` (drops leading zeros gracefully). */
function formatCountdown(seconds) {
  if (seconds == null) return "";
  if (seconds <= 0) return "any moment";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
