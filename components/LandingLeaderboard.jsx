"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Contract, JsonRpcProvider, formatEther } from "ethers";
import {
  CONTRACT_ADDRESS,
  FOOTMON_ABI,
  MONAD_CHAIN,
  ratingColor,
} from "@/lib/constants";

/**
 * Public leaderboard section for the landing page.
 */

const TOP_N = 8;

const TABS = [
  {
    id: "tournament",
    label: "Tournament",
    blurb: "On-chain squad ratings. Top score at payout time wins today's MON prize pool.",
  },
  {
    id: "duel",
    label: "Duels",
    blurb: "1v1 staked duels. Ranked by wins, then goal difference.",
  },
];

export default function LandingLeaderboard() {
  const [tab, setTab] = useState("tournament");
  const [byTab, setByTab] = useState({
    tournament: { loading: true, entries: [], error: null },
    duel: { loading: true, entries: [], error: null },
  });

  const usernameCacheRef = useRef(new Map());
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

    async function load() {
      setByTab((s) => ({ ...s, [tab]: { ...s[tab], loading: true, error: null } }));

      try {
        let entries = [];
        if (tab === "duel") {
          const res = await fetch(`/api/leaderboard?board=duel&limit=${TOP_N}`, {
            cache: "no-store",
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json();
          entries = (json.duel || []).slice(0, TOP_N);
        } else {
          entries = await loadDaily(readContractRef.current);
          await prefetchUsernames(entries.map((e) => e.player), usernameCacheRef.current);
        }

        if (!cancelled) {
          setByTab((s) => ({ ...s, [tab]: { loading: false, entries, error: null } }));
        }
      } catch (err) {
        if (!cancelled) {
          setByTab((s) => ({
            ...s,
            [tab]: { loading: false, entries: [], error: err.message || "Failed to load" },
          }));
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [tab]);

  const current = byTab[tab] || { loading: false, entries: [], error: null };
  const cta = tab === "duel"
    ? { href: "/play/duel", label: "Play a Duel" }
    : { href: "/play", label: "Play Solo" };

  return (
    <section className="landing-section" id="leaderboard" aria-label="Live leaderboard">
      <h2 className="section-heading">Live Leaderboard</h2>
      <p className="section-sub">
        The competition is on. See who&apos;s topping the board right now.
      </p>

      <div className="landing-lb">
        <div className="lb-tabs" role="tablist" aria-label="Leaderboard boards">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`lb-tab ${tab === t.id ? "lb-tab--active" : ""}`}
              onClick={() => setTab(t.id)}
              role="tab"
              aria-selected={tab === t.id}
              type="button"
            >
              {t.label}
            </button>
          ))}
        </div>

        <p className="lb-blurb">{TABS.find((t) => t.id === tab)?.blurb}</p>

        <div className="landing-lb-body">
          {current.loading ? (
            <div className="lb-loading">Loading…</div>
          ) : current.error ? (
            <div className="lb-error">Couldn&apos;t load the board. Try again in a moment.</div>
          ) : current.entries.length === 0 ? (
            <LandingEmpty tab={tab} />
          ) : tab === "tournament" ? (
            <TournamentTable entries={current.entries} usernameCache={usernameCacheRef.current} />
          ) : (
            <DuelTable entries={current.entries} />
          )}
        </div>

        {!current.loading && current.entries.length > 0 && (
          <div className="landing-lb-footer">
            <Link href={cta.href} className="hero-btn hero-btn--primary landing-lb-cta">
              {cta.label} &rarr;
            </Link>
            <span className="landing-lb-footer-note">
              Top the board and win MON prizes on Monad Testnet.
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

// ── Data loaders ────────────────────────────────────────────────────────────

async function loadDaily(contract) {
  if (!contract) return [];
  const count = Number(await contract.getEntriesCount());
  if (count === 0) return [];

  const batch = [];
  for (let i = 0; i < count; i++) batch.push(contract.getEntry(i));
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
  return entries.slice(0, TOP_N);
}

async function prefetchUsernames(addresses, cache) {
  const missing = [...new Set(
    (addresses || [])
      .filter(Boolean)
      .map((a) => String(a).toLowerCase())
      .filter((a) => !cache.has(a))
  )];
  if (missing.length === 0) return;

  try {
    const res = await fetch(`/api/profile?addresses=${missing.join(",")}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const { usernames } = await res.json();
    for (const a of missing) {
      if (usernames[a]) cache.set(a, usernames[a]);
    }
  } catch {
    // Fall back to shortened addresses.
  }
}

// ── Presentational helpers ──────────────────────────────────────────────────

function rankMedal(rank) {
  if (rank === 1) return "🥇";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return `#${rank}`;
}

function formatDiff(diff) {
  const n = Number(diff) || 0;
  return n > 0 ? `+${n}` : String(n);
}

function shortAddress(addr) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function displayNameFor(address, cache) {
  if (!address) return "—";
  const key = String(address).toLowerCase();
  return cache.get(key) || shortAddress(address);
}

// ── Empty state ─────────────────────────────────────────────────────────────

function LandingEmpty({ tab }) {
  const isDuel = tab === "duel";
  return (
    <div className="landing-lb-empty">
      <div className="landing-lb-empty-icon" aria-hidden="true">🏆</div>
      <div className="landing-lb-empty-title">No entries yet</div>
      <p className="landing-lb-empty-sub">
        {isDuel
          ? "Be the first to stake a duel and claim the top spot."
          : "Be the first to top this board — start a run now."}
      </p>
      <Link
        href={isDuel ? "/play/duel" : "/play"}
        className="hero-btn hero-btn--primary landing-lb-cta"
      >
        {isDuel ? "Play a Duel" : "Play Solo"} &rarr;
      </Link>
    </div>
  );
}

// ── Tables ──────────────────────────────────────────────────────────────────

function TournamentTable({ entries, usernameCache }) {
  return (
    <div className="landing-lb-scroll">
      <table className="lb-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Player</th>
            <th>GD</th>
            <th>Rating</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => {
            const gd = (Number(e.goalsFor ?? e.goals_for ?? 0)) - (Number(e.goalsAgainst ?? e.goals_against ?? 0));
            return (
              <tr key={i} className="lb-row">
                <td className="lb-rank">{rankMedal(i + 1)}</td>
                <td className="lb-player">
                  <span className="lb-name">{displayNameFor(e.player, usernameCache)}</span>
                </td>
                <td className="lb-gd" data-sign={gd >= 0 ? "pos" : "neg"}>
                  {formatDiff(gd)}
                </td>
                <td className="lb-score" style={{ color: ratingColor(e.score) }}>
                  {e.score.toFixed(2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DuelTable({ entries }) {
  return (
    <div className="landing-lb-scroll">
      <table className="lb-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Player</th>
            <th>Record</th>
            <th>GD</th>
            <th>Won</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={i} className="lb-row">
              <td className="lb-rank">{rankMedal(Number(e.rank))}</td>
              <td className="lb-player">
                <span className="lb-name">{e.username}</span>
              </td>
              <td className="lb-record">
                <span className="lb-w">{e.wins}W</span>{" "}
                <span className="lb-l">{e.losses}L</span>{" "}
                <span className="lb-d">{e.draws}D</span>
              </td>
              <td className="lb-gd" data-sign={Number(e.goal_diff) >= 0 ? "pos" : "neg"}>
                {formatDiff(e.goal_diff)}
              </td>
              <td className="lb-won">
                {parseFloat(formatEther(String(e.mon_won ?? "0"))).toFixed(3)} MON
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
