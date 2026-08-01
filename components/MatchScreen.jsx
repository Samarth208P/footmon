"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { getFlagUrl, ratingColor } from "@/lib/constants";

/**
 * Round name mapping — mirrors a real World Cup knockout structure.
 */
const ROUND_NAMES = {
  1: "GROUPS",
  2: "GROUPS",
  3: "GROUPS",
  4: "ROUND OF 16",
  5: "QUARTER-FINAL",
  6: "SEMI-FINAL",
  7: "FINAL",
};

// Real-time seconds it takes to play out one 90-minute round.
const SECONDS_PER_MATCH = 4.8;
const ROUND_PAUSE_MS = 1200;

/**
 * MatchScreen — campaign-style tournament visualization.
 *
 * Two modes:
 *   - "Automatic" — plays through rounds one at a time with a live clock.
 *   - Summary — once all rounds are played (or user skips), shows the full
 *     campaign sheet (like the reference images).
 */
export default function MatchScreen({
  matchResult,
  squadName,
  onRegister,
  onFinish,
  registering,
}) {
  const rounds = matchResult?.run?.rounds ?? [];
  const totalRounds = matchResult?.rounds ?? 7;
  const champion = !!matchResult?.run?.champion;
  const seed = matchResult?.seed ?? "";

  // ── Playback state ────────────────────────────────────────────────────────
  const [playedUpTo, setPlayedUpTo] = useState(0); // how many rounds have finished
  const [minute, setMinute] = useState(0);
  const [phase, setPhase] = useState("playing"); // playing | between | campaign
  const [expandedRound, setExpandedRound] = useState(null); // which row is open
  const startRef = useRef(null);

  const currentRound = rounds[playedUpTo];
  const isLastPlayedRound = playedUpTo === rounds.length - 1;

  // Drive the clock via requestAnimationFrame.
  useEffect(() => {
    if (phase !== "playing" || !currentRound) return;
    startRef.current = null;
    let rafId;

    const tick = (t) => {
      if (startRef.current === null) startRef.current = t;
      const elapsed = (t - startRef.current) / 1000;
      const virtual = Math.min(90, (elapsed / SECONDS_PER_MATCH) * 90);
      setMinute(virtual);
      if (virtual < 90) {
        rafId = requestAnimationFrame(tick);
      } else {
        setPhase("between");
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [phase, playedUpTo, currentRound]);

  // Between rounds: hold the final score for a beat, then advance.
  useEffect(() => {
    if (phase !== "between") return;
    const id = setTimeout(() => {
      if (isLastPlayedRound) {
        setPhase("campaign");
      } else {
        setPlayedUpTo((i) => i + 1);
        setMinute(0);
        setPhase("playing");
      }
    }, ROUND_PAUSE_MS);
    return () => clearTimeout(id);
  }, [phase, isLastPlayedRound]);

  // Skip to campaign view.
  const skipToEnd = () => {
    setPlayedUpTo(rounds.length - 1);
    setMinute(90);
    setPhase("campaign");
  };

  // Live scoreline for the current round during playback.
  const liveScore = useMemo(() => {
    if (!currentRound) return { you: 0, them: 0 };
    if (phase !== "playing") {
      return { you: currentRound.playerScore, them: currentRound.opponentScore };
    }
    let you = 0;
    let them = 0;
    for (const e of currentRound.events || []) {
      if (e.eventType !== "goal" || e.minute > minute) continue;
      if (e.team === "home" || e.team === "creator") you++;
      else them++;
    }
    return { you, them };
  }, [currentRound, minute, phase]);

  // ── Campaign view (after all rounds played or skip) ───────────────────────
  if (phase === "campaign") {
    return (
      <CampaignView
        rounds={rounds}
        totalRounds={totalRounds}
        matchResult={matchResult}
        champion={champion}
        seed={seed}
        squadName={squadName}
        expandedRound={expandedRound}
        setExpandedRound={setExpandedRound}
        onRegister={onRegister}
        onFinish={onFinish}
        registering={registering}
      />
    );
  }

  // ── Live match playback ───────────────────────────────────────────────────
  if (!currentRound) {
    return (
      <div className="match-screen">
        <div className="match-empty">No match data. <button onClick={onFinish}>Back</button></div>
      </div>
    );
  }

  const roundName = ROUND_NAMES[currentRound.round] || `ROUND ${currentRound.round}`;
  const opNation = currentRound.nation || null;
  const visibleGoals = (currentRound.events || []).filter(
    (e) => e.eventType === "goal" && e.minute <= minute
  );

  return (
    <div className="match-screen">
      {/* Mini ladder at top */}
      <div className="match-ladder">
        {Array.from({ length: totalRounds }, (_, i) => {
          const r = rounds[i];
          let state = "future";
          if (i < playedUpTo) state = r?.won ? "won" : "lost";
          else if (i === playedUpTo) state = "current";
          return (
            <div key={i} className={`ladder-pip ladder-pip--${state}`}>
              <span className="ladder-pip-num">{i + 1}</span>
            </div>
          );
        })}
      </div>

      <div className="match-card">
        <div className="match-round-tag">{roundName}</div>

        <div className="match-scoreboard">
          <div className="match-team match-team--you">
            <div className="match-team-info">
              <span className="match-team-name">{squadName || "Your Squad"}</span>
            </div>
          </div>

          <div className="match-score">
            <span className="match-score-num">{liveScore.you}</span>
            <span className="match-score-dash">–</span>
            <span className="match-score-num">{liveScore.them}</span>
          </div>

          <div className="match-team match-team--them">
            {opNation && (
              <img src={getFlagUrl(opNation)} alt={opNation} className="match-team-flag" />
            )}
            <div className="match-team-info match-team-info--right">
              <span className="match-team-name">{currentRound.opponentName}</span>
            </div>
          </div>
        </div>

        <div className="match-clock-row">
          <span className="match-clock-min">{Math.floor(minute)}&apos;</span>
        </div>

        <div className="match-events">
          <AnimatePresence initial={false}>
            {visibleGoals.length === 0 ? (
              <motion.div
                key="none"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="match-event-none"
              >
                Waiting for a chance…
              </motion.div>
            ) : (
              visibleGoals.map((e) => {
                const isYou = e.team === "home" || e.team === "creator";
                return (
                  <motion.div
                    key={e.seq}
                    className={`match-event ${isYou ? "match-event--you" : "match-event--them"}`}
                    initial={{ x: isYou ? -12 : 12, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    transition={{ duration: 0.2 }}
                  >
                    <span className="match-event-min">{e.minute}&apos;</span>
                    <span className="match-event-icon">⚽</span>
                    <span className="match-event-scorer">{e.scorerName || "Unknown"}</span>
                  </motion.div>
                );
              })
            )}
          </AnimatePresence>
        </div>

        <div className="match-actions">
          <button className="btn-match-skip" onClick={skipToEnd}>Skip to Campaign</button>
        </div>
      </div>
    </div>
  );
}

/**
 * CampaignView — the full tournament sheet shown after all rounds.
 * Inspired by the reference screenshots: round label on left, opponent name
 * with flag + year, score on right with win/loss indicator. Expandable
 * rows reveal per-match events.
 */
function CampaignView({
  rounds,
  totalRounds,
  matchResult,
  champion,
  seed,
  squadName,
  expandedRound,
  setExpandedRound,
  onRegister,
  onFinish,
  registering,
}) {
  const run = matchResult?.run ?? {};
  const goalsFor = run.goalsFor ?? 0;
  const goalsAgainst = run.goalsAgainst ?? 0;
  const gd = goalsFor - goalsAgainst;
  const wins = run.wins ?? 0;

  return (
    <div className="match-screen campaign-screen">
      {/* Header */}
      <div className="campaign-header">
        <div className="campaign-header-left">
          <span className="campaign-tag">CAMPAIGN · SEED #{seed.slice(0, 6).toUpperCase()}</span>
          <h1 className="campaign-title">THE CAMPAIGN</h1>
        </div>
        <div className="campaign-header-right">
          <button className="btn-match-skip" onClick={skipToEnd} style={{ visibility: "hidden" }}>
            Match by match
          </button>
        </div>
      </div>

      <div className="campaign-divider" />

      {/* Match rows */}
      <div className="campaign-rows">
        {rounds.map((r, i) => {
          const roundName = ROUND_NAMES[r.round] || `ROUND ${r.round}`;
          const isOpen = expandedRound === i;
          const goals = (r.events || []).filter((e) => e.eventType === "goal");
          const won = r.won;
          const isDraw = r.playerScore === r.opponentScore;
          const opNation = r.nation || null;

          return (
            <div key={i} className="campaign-match-block">
              <div
                className={`campaign-row ${won ? "campaign-row--won" : "campaign-row--lost"}`}
                onClick={() => setExpandedRound(isOpen ? null : i)}
                role="button"
                tabIndex={0}
              >
                <span className="campaign-row-stage">{roundName}</span>
                <span className="campaign-row-vs">vs</span>
                {opNation && (
                  <img
                    src={getFlagUrl(opNation)}
                    alt={opNation}
                    className="campaign-row-flag"
                  />
                )}
                <span className="campaign-row-opponent">{r.opponentName}</span>
                <span className={`campaign-row-score ${won ? "" : "campaign-row-score--lost"}`}>
                  {r.playerScore} – {r.opponentScore}
                </span>
                <span className="campaign-row-result">
                  {won ? (isDraw ? "PEN ✓" : "✓") : "✗"}
                </span>
                <span className="campaign-row-chevron">{isOpen ? "▾" : "▸"}</span>
              </div>

              <AnimatePresence initial={false}>
                {isOpen && goals.length > 0 && (
                  <motion.div
                    className="campaign-events"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    {goals.map((e) => {
                      const isYou = e.team === "home" || e.team === "creator";
                      return (
                        <div key={e.seq} className={`campaign-event ${isYou ? "campaign-event--you" : "campaign-event--them"}`}>
                          <span className="campaign-event-min">{e.minute}&apos;</span>
                          <span className="campaign-event-dot" />
                          <span className="campaign-event-scorer">{e.scorerName}</span>
                        </div>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {/* Bottom score card */}
      <div className={`campaign-bottom ${champion ? "campaign-bottom--champ" : ""}`}>
        <div className="campaign-bottom-score">
          <span className="campaign-bottom-big">{goalsFor}</span>
          <span className="campaign-bottom-sep">-</span>
          <span className="campaign-bottom-big">{goalsAgainst}</span>
        </div>
        <div className="campaign-bottom-stats">
          <div className="campaign-bottom-stat">
            <span className="campaign-bottom-stat-val">{wins}</span>
            <span className="campaign-bottom-stat-label">WINS</span>
          </div>
          <div className="campaign-bottom-stat">
            <span className="campaign-bottom-stat-val">{goalsFor}</span>
            <span className="campaign-bottom-stat-label">GOALS FOR</span>
          </div>
          <div className="campaign-bottom-stat">
            <span className="campaign-bottom-stat-val">{goalsAgainst}</span>
            <span className="campaign-bottom-stat-label">GOALS AGAINST</span>
          </div>
          <div className="campaign-bottom-stat">
            <span className="campaign-bottom-stat-val" style={{ color: gd >= 0 ? "var(--green)" : "var(--red)" }}>
              {gd >= 0 ? `+${gd}` : gd}
            </span>
            <span className="campaign-bottom-stat-label">GD</span>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="campaign-actions">
        {champion ? (
          <>
            <button
              className="btn-match-register"
              onClick={onRegister}
              disabled={registering}
            >
              {registering ? "Signing…" : "Register on Leaderboard 🏆"}
            </button>
            <button className="btn-match-back" onClick={onFinish} disabled={registering}>
              Skip
            </button>
          </>
        ) : (
          <>
            <p className="campaign-outcome-text">
              Knocked out in the {ROUND_NAMES[run.eliminatedInRound] || `Round ${run.eliminatedInRound}`}.
              This run won't be recorded.
            </p>
            <button className="btn-match-back" onClick={onFinish}>Try Again</button>
          </>
        )}
      </div>
    </div>
  );

  function skipToEnd() {} // no-op in campaign view, the button is hidden
}
