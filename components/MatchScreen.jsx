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
// Roughly the pace a broadcast pens shootout runs at — long enough that the
// viewer registers each kick, quick enough that a 12-kick sudden death
// doesn't drag.
const MS_PER_KICK = 650;
const PENS_HOLD_MS = 1600;

/**
 * Extract the shootout, if any, from a round's event stream.
 * Returns an object shaped like `runTournament`'s `round.penalties`:
 *   { homeScore, awayScore, kicks: [...] }
 *
 * The engine attaches `penalties` directly to the round object (server side).
 * For duel matches replayed from match_logs, the same info lives in the
 * event stream — this helper reconstructs it either way.
 */
function penaltiesFromRound(round) {
  if (round?.penalties) return round.penalties;
  const events = round?.events ?? [];
  const kickEvents = events.filter((e) => e.eventType === "penalty");
  if (kickEvents.length === 0) return null;

  const endEvent = events.find((e) => e.eventType === "pens_end");
  const homeScore = endEvent?.payload?.homePens
    ?? kickEvents.filter((e) => e.payload?.scored && (e.team === "home" || e.team === "creator")).length;
  const awayScore = endEvent?.payload?.awayPens
    ?? kickEvents.filter((e) => e.payload?.scored && (e.team === "away" || e.team === "joiner" || e.team === "ai")).length;
  const winner = endEvent?.payload?.winner
    ?? (homeScore > awayScore ? "home" : "away");

  const kicks = kickEvents.map((e) => ({
    side: (e.team === "home" || e.team === "creator") ? "home" : "away",
    kickNumber: e.payload?.kickNumber ?? 0,
    roundNumber: e.payload?.roundNumber ?? 0,
    suddenDeath: !!e.payload?.suddenDeath,
    scored: !!e.payload?.scored,
    taker: { name: e.scorerName ?? "—", rating: e.payload?.takerRating ?? null },
    keeper: { name: e.payload?.keeperName ?? null, rating: e.payload?.keeperRating ?? null },
    homeScore: e.payload?.homePens ?? 0,
    awayScore: e.payload?.awayPens ?? 0,
  }));

  return { homeScore, awayScore, winner, kicks };
}

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
  // playing → pens (if any) → between → playing (next round) → ... → campaign
  const [phase, setPhase] = useState("playing");
  const [penIndex, setPenIndex] = useState(0); // how many kicks are revealed
  const [expandedRound, setExpandedRound] = useState(null); // which row is open
  const startRef = useRef(null);

  const currentRound = rounds[playedUpTo];
  const currentPens = useMemo(() => penaltiesFromRound(currentRound), [currentRound]);
  const isLastPlayedRound = playedUpTo === rounds.length - 1;

  // Running pen tally as the animation reveals kicks. Declared up here (not
  // next to its render site) because it must be called on every render,
  // including the campaign-view path — the Rules of Hooks don't allow
  // conditional useMemo below the early returns.
  const penTally = useMemo(() => {
    if (!currentPens) return { you: 0, them: 0 };
    let y = 0, t = 0;
    for (let i = 0; i < Math.min(penIndex, currentPens.kicks.length); i++) {
      const k = currentPens.kicks[i];
      if (k.scored) {
        if (k.side === "home") y++;
        else t++;
      }
    }
    return { you: y, them: t };
  }, [currentPens, penIndex]);

  // Drive the clock via requestAnimationFrame during the 90-minute phase.
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
        // If the round has penalties, run the shootout animation next.
        // Otherwise settle straight into the between-rounds pause.
        if (currentPens) {
          setPenIndex(0);
          setPhase("pens");
        } else {
          setPhase("between");
        }
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [phase, playedUpTo, currentRound, currentPens]);

  // Penalty shootout animation: reveal one kick at a time.
  useEffect(() => {
    if (phase !== "pens" || !currentPens) return;
    if (penIndex >= currentPens.kicks.length) {
      // Hold the final shootout scoreline before moving on.
      const id = setTimeout(() => setPhase("between"), PENS_HOLD_MS);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => setPenIndex((i) => i + 1), MS_PER_KICK);
    return () => clearTimeout(id);
  }, [phase, penIndex, currentPens]);

  // Between rounds: hold the final score for a beat, then advance.
  useEffect(() => {
    if (phase !== "between") return;
    const id = setTimeout(() => {
      if (isLastPlayedRound) {
        setPhase("campaign");
      } else {
        setPlayedUpTo((i) => i + 1);
        setMinute(0);
        setPenIndex(0);
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
    // Once we've moved past regulation, freeze the 90-minute score. Pens
    // are shown as a separate scoreline below the main one.
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
        <div className="match-round-tag">
          {phase === "pens" ? `${roundName} · PENALTIES` : roundName}
        </div>

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

        {phase === "playing" && (
          <div className="match-clock-row">
            <span className="match-clock-min">{Math.floor(minute)}&apos;</span>
          </div>
        )}

        {/* Shootout panel — live animation, or the goal feed if we're still in regulation */}
        {phase === "pens" && currentPens ? (
          <PenaltyShootout
            pens={currentPens}
            revealed={penIndex}
            youLabel={squadName || "Your Squad"}
            themLabel={currentRound.opponentName}
            youScore={penTally.you}
            themScore={penTally.them}
            done={penIndex >= currentPens.kicks.length}
          />
        ) : (
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
        )}

        <div className="match-actions">
          <button className="btn-match-skip" onClick={skipToEnd}>Skip to Campaign</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Renders a full 5-per-side (plus sudden-death) shootout row.
 *
 * Circles are keyed by kick number, so the row grows on the right for
 * sudden death without reshuffling the first five. During live playback,
 * `revealed` counts how many kicks have been unveiled — pending kicks
 * render as an empty outlined circle, taken kicks as filled green/red.
 */
function PenaltyShootout({ pens, revealed, youLabel, themLabel, youScore, themScore, done }) {
  // Group kicks per side, in order, so both rows are aligned by kick index.
  const homeKicks = pens.kicks.filter((k) => k.side === "home");
  const awayKicks = pens.kicks.filter((k) => k.side === "away");

  // The last kick that was "just" taken — used for the pulse animation.
  const currentKickSeq = Math.min(revealed, pens.kicks.length) - 1;

  // Show at least 5 slots per side; extend for sudden death rounds.
  const maxRegSlots = 5;
  const homeSlots = Math.max(maxRegSlots, homeKicks.length);
  const awaySlots = Math.max(maxRegSlots, awayKicks.length);

  const cellFor = (kick, kickIdx, sideKicks, side) => {
    if (!kick) {
      return (
        <div key={kickIdx} className="pens-slot pens-slot--pending" aria-label="Pending" />
      );
    }

    // Find this kick's index in the flat kicks array (the reveal order).
    const flatIdx = pens.kicks.indexOf(kick);
    const taken = flatIdx <= currentKickSeq;
    if (!taken) {
      return (
        <div
          key={kickIdx}
          className={`pens-slot pens-slot--pending${kick.suddenDeath ? " pens-slot--sd" : ""}`}
          aria-label="Pending"
        />
      );
    }

    const isLatest = flatIdx === currentKickSeq;
    const cls = `pens-slot ${kick.scored ? "pens-slot--scored" : "pens-slot--missed"}${
      kick.suddenDeath ? " pens-slot--sd" : ""
    }${isLatest ? " pens-slot--latest" : ""}`;
    return (
      <motion.div
        key={kickIdx}
        className={cls}
        initial={{ scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 22 }}
        title={`${kick.taker.name} — ${kick.scored ? "scored" : "missed"}${
          kick.suddenDeath ? " (sudden death)" : ""
        }`}
      >
        <span aria-hidden>{kick.scored ? "✓" : "✗"}</span>
      </motion.div>
    );
  };

  const renderRow = (label, score, kicks, slotCount, side) => {
    const cells = [];
    for (let i = 0; i < slotCount; i++) {
      cells.push(cellFor(kicks[i], i, kicks, side));
      // Divider between regulation 5 and sudden death.
      if (i === maxRegSlots - 1 && slotCount > maxRegSlots) {
        cells.push(<span key={`sep-${side}`} className="pens-sep" aria-hidden />);
      }
    }
    return (
      <div className="pens-row">
        <span className="pens-team">{label}</span>
        <div className="pens-slots">{cells}</div>
        <span className="pens-score">{score}</span>
      </div>
    );
  };

  // Show which player is about to take, if we're mid-shootout.
  const upcoming = pens.kicks[Math.min(revealed, pens.kicks.length - 1)];
  const justTaken = pens.kicks[Math.max(0, revealed - 1)];
  const strap = done
    ? `Result: ${pens.winner === "home" ? youLabel : themLabel} advance`
    : revealed === 0
      ? "First kick"
      : justTaken
        ? `${justTaken.taker.name} — ${justTaken.scored ? "scored" : "missed"}${
            justTaken.suddenDeath ? " · sudden death" : ""
          }`
        : "";

  return (
    <div className="pens-panel">
      <div className="pens-title">Penalty Shootout</div>
      {renderRow(youLabel, youScore, homeKicks, homeSlots, "home")}
      {renderRow(themLabel, themScore, awayKicks, awaySlots, "away")}
      <div className="pens-strap">{strap}</div>
    </div>
  );
}

/**
 * CampaignView — the full tournament sheet shown after all rounds.
 * Inspired by the reference screenshots: round label on left, opponent name
 * with flag + year, score on right with win/loss indicator. Expandable
 * rows reveal per-match events plus, if the tie went to penalties, the
 * full shootout with every kick colour-coded.
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
  const losses = rounds.length - wins;

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
          const pens = penaltiesFromRound(r);
          const won = r.won;
          const wentToPens = !!pens;
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
                  {wentToPens && (
                    <span className="campaign-row-pens">
                      {" "}({pens.homeScore}-{pens.awayScore} p)
                    </span>
                  )}
                </span>
                <span className="campaign-row-result">
                  {won ? (wentToPens ? "PEN ✓" : "✓") : (wentToPens ? "PEN ✗" : "✗")}
                </span>
                <span className="campaign-row-chevron">{isOpen ? "▾" : "▸"}</span>
              </div>

              <AnimatePresence initial={false}>
                {isOpen && (goals.length > 0 || wentToPens) && (
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
                    {wentToPens && (
                      <div className="campaign-pens-block">
                        <PenaltyShootout
                          pens={pens}
                          revealed={pens.kicks.length}
                          youLabel={squadName || "Your Squad"}
                          themLabel={r.opponentName}
                          youScore={pens.homeScore}
                          themScore={pens.awayScore}
                          done
                        />
                      </div>
                    )}
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
          <span className="campaign-bottom-big campaign-bottom-big--win">{wins}</span>
          <span className="campaign-bottom-sep">-</span>
          <span className="campaign-bottom-big campaign-bottom-big--loss">{losses}</span>
        </div>
        <div className="campaign-bottom-stats">
          <div className="campaign-bottom-stat">
            <span className="campaign-bottom-stat-val">{wins}</span>
            <span className="campaign-bottom-stat-label">WON</span>
          </div>
          <div className="campaign-bottom-stat">
            <span className="campaign-bottom-stat-val">{losses}</span>
            <span className="campaign-bottom-stat-label">LOST</span>
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
