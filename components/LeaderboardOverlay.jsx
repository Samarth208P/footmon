"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useInView } from "motion/react";
import { ratingColor, getFlagUrl } from "@/lib/constants";
import { formatEther } from "ethers";
import DailyPrizeBadge from "./DailyPrizeBadge";

/**
 * Table-row equivalent of AnimatedItem — a `<tr>` can't live inside
 * AnimatedItem's `<div>`, so we replicate the scale-in-on-view animation
 * here. Keeps the leaderboard's semantic table markup intact.
 */
function AnimatedRow({ children, className, index }) {
  const ref = useRef(null);
  const inView = useInView(ref, { amount: 0.5, triggerOnce: false });
  return (
    <motion.tr
      ref={ref}
      data-index={index}
      className={className}
      initial={{ scale: 0.7, opacity: 0 }}
      animate={inView ? { scale: 1, opacity: 1 } : { scale: 0.7, opacity: 0 }}
      transition={{ duration: 0.2, delay: 0.03 }}
      style={{ transformOrigin: "left center" }}
    >
      {children}
    </motion.tr>
  );
}

/**
 * Leaderboard overlay with Tournament / Duel / Daily tabs.
 */
export default function LeaderboardOverlay({ open, onClose, contract, address, usernameFor }) {
  const [board, setBoard] = useState("tournament");
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    loadBoard(board);
  }, [open, board]);

  const loadBoard = async (b) => {
    setLoading(true);
    setEntries([]);
    try {
      if (b === "tournament" || b === "duel") {
        const res = await fetch(`/api/leaderboard?board=${b}&limit=100`, { cache: "no-store" });
        const json = await res.json();
        setEntries(json[b] || []);
      } else {
        // Daily (on-chain)
        const data = await contract.getLeaderboard();
        setEntries(data);
      }
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <div id="leaderboardOverlay" className="open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lb-panel">
        <div className="lb-nav">
          <span className="lb-nav-title">🏆 Leaderboard · Daily Prize</span>
          <button onClick={onClose} title="Close">✕</button>
        </div>

        <DailyPrizeBadge variant="banner" />

        <div className="lb-tabs" role="tablist">
          {["tournament", "duel", "daily"].map((b) => (
            <button key={b} className={`lb-tab ${board === b ? "lb-tab--active" : ""}`} onClick={() => setBoard(b)}>
              {b === "tournament" ? "Tournament" : b === "duel" ? "Duels" : "Daily"}
            </button>
          ))}
        </div>

        <div className="lb-panel-body">
          {loading ? (
            <div className="lb-loading">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="lb-empty">No entries yet.</div>
          ) : board === "tournament" ? (
            <TournamentTable entries={entries} myAddr={address} />
          ) : board === "duel" ? (
            <DuelTable entries={entries} myAddr={address} />
          ) : (
            <DailyTable entries={entries} myAddr={address} usernameFor={usernameFor} />
          )}
        </div>
      </div>
    </div>
  );
}

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

function isMe(addr, myAddr) {
  return Boolean(myAddr && addr && addr.toLowerCase() === myAddr.toLowerCase());
}

function TournamentTable({ entries, myAddr }) {
  return (
    <div className="lb-scroll">
      <p className="lb-blurb">Seven matches, one loss ends the run. Ranked by wins, then goal difference.</p>
      <table className="lb-table">
        <thead><tr><th>Rank</th><th>Player</th><th>Wins</th><th>GD</th><th>Goals</th><th>Rating</th></tr></thead>
        <tbody>
          {entries.map((e, i) => {
            const mine = isMe(e.address, myAddr);
            const champion = Number(e.wins) === 7;
            return (
              <AnimatedRow key={i} index={i} className={`lb-row ${mine ? "lb-row--me" : ""} ${champion ? "lb-row--champ" : ""}`}>
                <td className="lb-rank">{rankMedal(Number(e.rank))}</td>
                <td className="lb-player">
                  <span className="lb-name">{mine ? `${e.username} (you)` : e.username}</span>
                  {champion && <span className="lb-badge">Champion</span>}
                </td>
                <td className="lb-wins"><span className="lb-wins-pill">{e.wins}/7</span></td>
                <td className="lb-gd" data-sign={Number(e.goal_diff) >= 0 ? "pos" : "neg"}>{formatDiff(e.goal_diff)}</td>
                <td className="lb-goals">{e.goals_for}:{e.goals_against}</td>
                <td className="lb-score" style={{ color: ratingColor(Number(e.team_rating)) }}>{Number(e.team_rating).toFixed(1)}</td>
              </AnimatedRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DuelTable({ entries, myAddr }) {
  return (
    <div className="lb-scroll">
      <p className="lb-blurb">1v1 staked duels. Ranked by wins, then goal difference.</p>
      <table className="lb-table">
        <thead><tr><th>Rank</th><th>Player</th><th>Record</th><th>GD</th><th>Goals</th><th>Won</th></tr></thead>
        <tbody>
          {entries.map((e, i) => {
            const mine = isMe(e.address, myAddr);
            return (
              <AnimatedRow key={i} index={i} className={`lb-row ${mine ? "lb-row--me" : ""}`}>
                <td className="lb-rank">{rankMedal(Number(e.rank))}</td>
                <td className="lb-player"><span className="lb-name">{mine ? `${e.username} (you)` : e.username}</span></td>
                <td className="lb-record"><span className="lb-w">{e.wins}W</span> <span className="lb-l">{e.losses}L</span> <span className="lb-d">{e.draws}D</span></td>
                <td className="lb-gd" data-sign={Number(e.goal_diff) >= 0 ? "pos" : "neg"}>{formatDiff(e.goal_diff)}</td>
                <td className="lb-goals">{e.goals_for}:{e.goals_against}</td>
                <td className="lb-won">{parseFloat(formatEther(String(e.mon_won ?? "0"))).toFixed(3)} MON</td>
              </AnimatedRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DailyTable({ entries, myAddr, usernameFor }) {
  return (
    <div className="lb-scroll">
      <p className="lb-blurb">On-chain squad ratings. Top score at payout time wins today&apos;s MON prize pool.</p>
      <table className="lb-table">
        <thead><tr><th>Rank</th><th>Player</th><th>Nation · Year</th><th>Formation</th><th>Rating</th></tr></thead>
        <tbody>
          {entries.map((e, i) => {
            const mine = isMe(e.player, myAddr);
            return (
              <AnimatedRow key={i} index={i} className={`lb-row ${mine ? "lb-row--me" : ""}`}>
                <td className="lb-rank">{rankMedal(i + 1)}</td>
                <td className="lb-player"><span className="lb-name">{mine ? "You" : usernameFor?.(e.player) || `${e.player.slice(0, 6)}…`}</span></td>
                <td className="lb-nation">
                  <img className="lb-flag" src={getFlagUrl(e.nation)} alt={e.nation} style={{ width: 18, height: 13 }} />
                  {" "}{e.nation} {e.year}
                </td>
                <td className="lb-formation">{e.formation}</td>
                <td className="lb-score" style={{ color: ratingColor(e.score) }}>{e.score.toFixed(2)}</td>
              </AnimatedRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
