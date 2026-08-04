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
  const [leader, setLeader] = useState(null); // { address, username, score }
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
      try {
        const resPrize = await fetch("/api/tournament/prize-pool", { cache: "no-store" }).catch(() => null);
        let apiPrizePool = null;
        let apiTime = null;
        if (resPrize && resPrize.ok) {
          const prizeData = await resPrize.json();
          apiPrizePool = prizeData.prizePool;
          apiTime = prizeData.timeUntilPayout;
        }

        if (cancelled) return;
        if (apiPrizePool !== null) setPrizePool(apiPrizePool);
        if (apiTime !== null) setTimeUntilPayout(apiTime);

        const rc = readContractRef.current;
        if (!rc) {
          setLoaded(true);
          return;
        }

        const count = await rc.getEntriesCount();
        if (cancelled) return;

        // Find the current leader
        const entryCount = Number(count);
        if (entryCount > 0) {
          const entries = [];
          for (let i = 0; i < entryCount; i++) {
            entries.push(rc.getEntry(i));
          }
          const raw = await Promise.all(entries);
          if (cancelled) return;

          let topEntry = null;
          for (const e of raw) {
            const score = Number(e.score) / 100;
            if (!topEntry || score > topEntry.score) {
              topEntry = { address: e.player, score };
            }
          }

          if (topEntry) {
            // Try to resolve username
            try {
              const res = await fetch(`/api/profile?addresses=${topEntry.address.toLowerCase()}`, { cache: "no-store" });
              if (res.ok) {
                const { usernames } = await res.json();
                const name = usernames[topEntry.address.toLowerCase()];
                if (name && !cancelled) {
                  topEntry.username = name;
                }
              }
            } catch {}
            if (!cancelled) setLeader(topEntry);
          }
        } else {
          if (!cancelled) setLeader(null);
        }

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
    : "0 MON";

  const countdown = formatCountdown(timeUntilPayout);

  const leaderDisplay = leader
    ? leader.username || shortAddress(leader.address)
    : null;

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
      {leaderDisplay && (
        <div className="daily-prize-hero-leader">
          <span className="daily-prize-hero-leader-label">Leading</span>
          <span className="daily-prize-hero-leader-name">{leaderDisplay}</span>
        </div>
      )}
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

function shortAddress(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
