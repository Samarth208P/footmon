"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ratingColor } from "@/lib/constants";
import { play as playSound } from "@/lib/sound";
import PenaltyShootout from "./PenaltyShootout";

// Real-time seconds to play out one 90-minute match. Duels are the
// wagered format so the pacing is deliberately unhurried — each virtual
// second is worth ~2 game minutes, giving both players time to read the
// commentary feed and feel the score tick. Solo tournament matches run
// on a separate, faster clock (MatchScreen).
const SECONDS_PER_MATCH = 45;
const RESULT_REVEAL_MS = 1600;

/**
 * Wei-string → decimal MON, without pulling ethers into the client bundle.
 */
function weiToMon(wei) {
  const s = String(wei ?? "0").padStart(19, "0");
  const whole = s.slice(0, -18) || "0";
  const frac = s.slice(-18).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function shortAddr(addr) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * DuelMatchScreen — head-to-head match visualization.
 *
 * Plays back the goal-by-goal timeline the server recorded, drives a virtual
 * clock via requestAnimationFrame, and reveals the winner with a celebration
 * banner once full-time hits.
 */
export default function DuelMatchScreen({
  matchResult,
  room,
  myAddress,
  myUsername,
  opponentUsername,
  onBackToLobby,
  onRetry,
  error,
  loading,
}) {
  const matchLogs = matchResult?.matchLogs ?? [];
  const payoutMon = weiToMon(matchResult?.payoutWei);
  const isSettled = Boolean(matchResult?.settled);
  // Server surfaces a settlement error string when the resolver push
  // failed (RPC dropped, resolver out of gas, etc.). We show it verbatim
  // on the reveal card so the winner isn't stuck staring at a
  // "hold tight…" spinner forever.
  const settlementError = matchResult?.settlementError || null;
  // Optional server hint: some settle paths tell us the exact tx that
  // pushed the funds. We surface it in the payout note when we have it.
  const settlementTx =
    matchResult?.settlementTx || matchResult?.resolver_tx || null;

  // Wallet addresses come in checksum-cased from useAppKitAccount(), while
  // room.creator / room.joiner are stored lowercased. Normalise before
  // comparing so we don't flip creator/joiner when rendering the reveal.
  const myAddressLc = myAddress ? String(myAddress).toLowerCase() : null;
  const iAmCreator = Boolean(myAddressLc) && room?.creator === myAddressLc;
  const myLabel = myUsername || (myAddress ? shortAddr(myAddress) : "You");
  const oppAddr = iAmCreator ? room?.joiner : room?.creator;
  const oppLabel = opponentUsername || shortAddr(oppAddr);

  // Total goals actually recorded (final tally). We drive score animation off
  // the events themselves rather than the room's score fields so the number
  // is always consistent with what has ticked past on the clock.
  const finalCreator = Number(room?.score_creator ?? 0);
  const finalJoiner = Number(room?.score_joiner ?? 0);

  // Timeline: kickoff → goals → half_time → goals → full_time.
  const timeline = useMemo(() => {
    // Sort by seq to preserve authored order, then by minute for cosmetic sanity.
    return [...matchLogs].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }, [matchLogs]);

  const hasTimeline = timeline.length > 0;

  // ── Virtual clock ─────────────────────────────────────────────────────────
  const [minute, setMinute] = useState(0);
  const [phase, setPhase] = useState("kickoff"); // kickoff | firstHalf | halfTime | secondHalf | pens | fullTime | reveal
  const [penIndex, setPenIndex] = useState(0); // how many kicks are revealed
  const [flash, setFlash] = useState(null); // "creator" | "joiner" — flashes score row
  const [goalCelebration, setGoalCelebration] = useState(null); // "me" | "them" — full-screen flash
  const [reveal, setReveal] = useState(false);
  const [shaking, setShaking] = useState(false);
  const startRef = useRef(null);
  const flashTimerRef = useRef(null);
  const goalCelebTimerRef = useRef(null);
  const lastShownSeqRef = useRef(-1);

  // Trigger a brief flash on the scoring side and clear it after ~600ms.
  const pulseFlash = (side) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlash(side);
    flashTimerRef.current = setTimeout(() => setFlash(null), 650);
  };

  // Goal celebration: screen flash + shake effect.
  const triggerGoalCelebration = (forMe) => {
    setGoalCelebration(forMe ? "me" : "them");
    setShaking(true);
    if (goalCelebTimerRef.current) clearTimeout(goalCelebTimerRef.current);
    goalCelebTimerRef.current = setTimeout(() => {
      setGoalCelebration(null);
      setShaking(false);
    }, 800);
  };

  // Play the clock as soon as we have a timeline.
  
  const currentPens = useMemo(() => {
    const kickEvents = timeline.filter((e) => e.event_type === "penalty");
    if (kickEvents.length === 0) return null;

    const endEvent = timeline.find((e) => e.event_type === "pens_end");
    const creatorScore = endEvent?.payload?.homePens ?? kickEvents.filter((e) => e.payload?.scored && (e.team === "home" || e.team === "creator")).length;
    const joinerScore = endEvent?.payload?.awayPens ?? kickEvents.filter((e) => e.payload?.scored && (e.team === "away" || e.team === "joiner")).length;

    const myPensScore = iAmCreator ? creatorScore : joinerScore;
    const oppPensScore = iAmCreator ? joinerScore : creatorScore;
    const winner = endEvent?.payload?.winner ?? (creatorScore > joinerScore ? "creator" : "joiner");

    const kicks = kickEvents.map((e) => {
      const isCreatorSide = e.team === "home" || e.team === "creator";
      const isMySide = (iAmCreator && isCreatorSide) || (!iAmCreator && !isCreatorSide);
      return {
        side: isMySide ? "home" : "away",
        kickNumber: e.payload?.kickNumber ?? 0,
        suddenDeath: !!e.payload?.suddenDeath,
        scored: !!e.payload?.scored,
        taker: { name: e.scorer_name ?? "—" },
      };
    });

    const winnerSide = (iAmCreator && winner === "creator") || (!iAmCreator && winner === "joiner") ? "home" : "away";

    return { homeScore: myPensScore, awayScore: oppPensScore, winner: winnerSide, kicks };
  }, [timeline, iAmCreator]);

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

  useEffect(() => {
    if (!hasTimeline || phase === "fullTime" || phase === "reveal") return;
    startRef.current = null;
    let rafId;

    const tick = (t) => {
      if (startRef.current === null) startRef.current = t;
      const elapsed = (t - startRef.current) / 1000;
      const virtual = Math.min(90, (elapsed / SECONDS_PER_MATCH) * 90);
      setMinute(virtual);

      if (virtual >= 45 && phase === "kickoff") setPhase("firstHalf");
      if (virtual >= 90) {
        if (currentPens) {
          setPhase("pens");
          setPenIndex(0);
        } else {
          setPhase("fullTime");
        }
        return;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTimeline]);

  // Watch events as the clock ticks past them and pulse the side that scored.
  useEffect(() => {
    for (const e of timeline) {
      if ((e.minute ?? 0) > minute) break;
      if ((e.seq ?? -1) <= lastShownSeqRef.current) continue;
      lastShownSeqRef.current = e.seq;
      if (e.event_type === "goal") {
        const side = e.team === "home" || e.team === "creator" ? "creator" : "joiner";
        const forMe = (iAmCreator && side === "creator") || (!iAmCreator && side === "joiner");
        pulseFlash(side);
        triggerGoalCelebration(forMe);
        playSound("goal");
      }
    }
  }, [minute, timeline]);

  // Penalty shootout animation: reveal one kick at a time.
  useEffect(() => {
    if (phase !== "pens" || !currentPens) return;
    if (penIndex >= currentPens.kicks.length) {
      const id = setTimeout(() => setPhase("fullTime"), 1600);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => setPenIndex((i) => i + 1), 650);
    return () => clearTimeout(id);
  }, [phase, penIndex, currentPens]);

  // After full-time, hold a beat before revealing the winner banner.
  useEffect(() => {
    if (phase !== "fullTime") return;
    const id = setTimeout(() => {
      setPhase("reveal");
      setReveal(true);
    }, RESULT_REVEAL_MS);
    return () => clearTimeout(id);
  }, [phase]);

  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    if (goalCelebTimerRef.current) clearTimeout(goalCelebTimerRef.current);
  }, []);

  // Skip animation and jump straight to the reveal.
  const skipToEnd = () => {
    setMinute(90);
    if (currentPens) {
      setPenIndex(currentPens.kicks.length);
    }
    setPhase("reveal");
    setReveal(true);
  };

  // ── Live scores derived from the clock ───────────────────────────────────
  const liveScore = useMemo(() => {
    let c = 0;
    let j = 0;
    for (const e of timeline) {
      if (e.event_type !== "goal") continue;
      if ((e.minute ?? 0) > minute) break;
      if (e.team === "home" || e.team === "creator") c++;
      else j++;
    }
    return { creator: c, joiner: j };
  }, [minute, timeline]);

  // Final numbers used on the reveal card — trust the server if it's there.
  const finalScore = {
    creator: phase === "reveal" || phase === "fullTime" ? finalCreator : liveScore.creator,
    joiner: phase === "reveal" || phase === "fullTime" ? finalJoiner : liveScore.joiner,
  };

  const myScore = iAmCreator ? finalScore.creator : finalScore.joiner;
  const oppScore = iAmCreator ? finalScore.joiner : finalScore.creator;
  // Prefer room.winner over raw score comparison — a penalty shootout
  // produces a decisive winner even when the regulation score is level.
  const winnerAddr = room?.winner ? String(room.winner).toLowerCase() : null;
  const iWon = phase === "reveal" && winnerAddr === myAddressLc;
  const iLost = phase === "reveal" && winnerAddr != null && winnerAddr !== myAddressLc;
  const isDraw = phase === "reveal" && !room?.winner;

  // Play the reveal cue exactly once when we transition into the reveal
  // phase. A ref guard avoids retriggers on subsequent renders of the same
  // outcome.
  const revealCuedRef = useRef(false);
  useEffect(() => {
    if (phase !== "reveal") {
      revealCuedRef.current = false;
      return;
    }
    if (revealCuedRef.current) return;
    revealCuedRef.current = true;
    if (iWon) playSound("victory");
    else if (iLost) playSound("defeat");
    else playSound("draw");
  }, [phase, iWon, iLost, isDraw]);

  // Note: the winning stake is pushed directly from the contract to the
  // winner's wallet the moment the resolver calls resolveDuel — there's
  // no pull-payment step and no claim button in the UI.

  // Events visible so far, sliced to what's ticked past. Keep narrative
  // markers (kickoff / half_time / full_time / forfeit) alongside the goals
  // so the commentary feed reads like a proper match report.
  const visibleEvents = useMemo(() => {
    const kinds = new Set(["goal", "kickoff", "half_time", "full_time", "forfeit", "pens_start", "penalty", "pens_end"]);
    return timeline.filter(
      (e) => kinds.has(e.event_type) && (e.minute ?? 0) <= minute
    );
  }, [timeline, minute]);

  // Half-time banner shows for one clock tick around minute 45.
  const showHalfTimeBanner = minute >= 45 && minute < 46 && phase === "firstHalf";

  // ── Error state ──────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="duel-match">
        <div className="duel-match-loading duel-match-loading--error">
          <div className="duel-match-loading-title">Simulation failed</div>
          <div className="duel-match-loading-sub">{error}</div>
          <div className="duel-match-error-actions">
            {onRetry && (
              <button className="duel-match-back" onClick={onRetry}>
                Retry
              </button>
            )}
            <button className="duel-match-skip duel-match-skip--inline" onClick={onBackToLobby}>
              Back to lobby
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Loading / missing states ─────────────────────────────────────────────
  if (loading || !hasTimeline) {
    return (
      <div className="duel-match">
        <div className="duel-match-loading">
          <div className="duel-match-loading-orbit">
            <span className="duel-match-loading-ball" />
          </div>
          <div className="duel-match-loading-title">Match in progress…</div>
          <div className="duel-match-loading-sub">
            The two squads are being simulated on the server. Hold tight.
          </div>
        </div>
      </div>
    );
  }

  const creatorMinuteLabel = Math.min(90, Math.floor(minute));
  const clockLabel = phase === "reveal" || phase === "fullTime" ? "FT" : `${creatorMinuteLabel}'`;

  return (
    <div className={`duel-match ${shaking ? "duel-match--shake" : ""}`}>
      {/* Goal celebration flash overlay */}
      <AnimatePresence>
        {goalCelebration && (
          <motion.div
            className={`duel-match-goal-flash duel-match-goal-flash--${goalCelebration}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.6, 0.3, 0] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.7, ease: "easeOut" }}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>

      {/* Ambient pitch background */}
      <div className="duel-match-bg" aria-hidden="true">
        <div className="duel-match-bg-glow duel-match-bg-glow--left" />
        <div className="duel-match-bg-glow duel-match-bg-glow--right" />
      </div>

      {/* Scoreboard */}
      <div className="duel-match-board">
        <SideBadge
          label={iAmCreator ? myLabel : oppLabel}
          isYou={iAmCreator}
          side="left"
          flash={flash === "creator"}
          score={liveScore.creator}
        />

        <div className="duel-match-center">
          <div className="duel-match-clock">
            <span className={`duel-match-clock-num ${phase === "reveal" ? "duel-match-clock-num--ft" : ""}`}>
              {clockLabel}
            </span>
            <span className="duel-match-clock-label">
              {phase === "kickoff" && "1st half"}
              {phase === "firstHalf" && "1st half"}
              {phase === "halfTime" && "Half time"}
              {phase === "secondHalf" && "2nd half"}
              {phase === "fullTime" && "Full time"}
              {phase === "reveal" && "Full time"}
            </span>
          </div>
          <ProgressRing minute={minute} />
        </div>

        <SideBadge
          label={iAmCreator ? oppLabel : myLabel}
          isYou={!iAmCreator}
          side="right"
          flash={flash === "joiner"}
          score={liveScore.joiner}
        />
      </div>

      {/* Half-time flourish */}
      <AnimatePresence>
        {showHalfTimeBanner && (
          <motion.div
            className="duel-match-halftime"
            initial={{ scale: 0.3, opacity: 0, rotateX: 90 }}
            animate={{ scale: 1, opacity: 1, rotateX: 0 }}
            exit={{ scale: 1.2, opacity: 0, y: -20 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
          >
            HALF TIME
          </motion.div>
        )}
      </AnimatePresence>

      {/* Shootout panel — live animation, or the goal feed if we're still in regulation */}
      {phase === "pens" || (phase === "reveal" && currentPens) ? (
        <PenaltyShootout
          pens={currentPens}
          revealed={penIndex}
          youLabel={myLabel}
          themLabel={oppLabel}
          youScore={penTally.you}
          themScore={penTally.them}
          done={penIndex >= currentPens.kicks.length}
        />
      ) : (
      <div className="duel-match-feed">
        <div className="duel-match-feed-title">Commentary</div>
        <div className="duel-match-feed-scroll">
          <AnimatePresence initial={false}>
            {visibleEvents.length === 0 ? (
              <motion.div
                key="empty"
                className="duel-match-feed-empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                Warming up…
              </motion.div>
            ) : (
              visibleEvents.map((e) => {
                const kind = e.event_type;
                const forCreator = e.team === "home" || e.team === "creator";
                const forMe = (iAmCreator && forCreator) || (!iAmCreator && !forCreator);

                if (kind === "goal") {
                  return (
                    <motion.div
                      key={e.seq}
                      className={`duel-match-feed-row ${forMe ? "duel-match-feed-row--me" : "duel-match-feed-row--them"}`}
                      initial={{ x: forMe ? -24 : 24, opacity: 0 }}
                      animate={{ x: 0, opacity: 1 }}
                      transition={{ duration: 0.25, ease: "easeOut" }}
                    >
                      <span className="duel-match-feed-min">{e.minute}&apos;</span>
                      <span className="duel-match-feed-icon">⚽</span>
                      <span className="duel-match-feed-scorer">
                        <strong>GOAL!</strong> {e.scorer_name || "Unknown"}
                      </span>
                      <span className="duel-match-feed-team">
                        {forMe ? "YOU" : "OPP"}
                      </span>
                    </motion.div>
                  );
                }

                if (kind === "forfeit") {
                  return (
                    <motion.div
                      key={e.seq}
                      className="duel-match-feed-row duel-match-feed-row--marker"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                    >
                      <span className="duel-match-feed-icon">🚩</span>
                      <span className="duel-match-feed-scorer">
                        Forfeit — opponent&apos;s clock expired.
                      </span>
                    </motion.div>
                  );
                }

                if (kind === "pens_start") {
                  return (
                    <motion.div
                      key={e.seq}
                      className="duel-match-feed-row duel-match-feed-row--marker"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                    >
                      <span className="duel-match-feed-min">90&apos;</span>
                      <span className="duel-match-feed-icon">⚡</span>
                      <span className="duel-match-feed-scorer">Penalty shootout!</span>
                    </motion.div>
                  );
                }

                if (kind === "penalty") {
                  const scored = e.payload?.scored;
                  const penSide = e.team === "home" || e.team === "creator" ? "creator" : "joiner";
                  const forMe = (iAmCreator && penSide === "creator") || (!iAmCreator && penSide === "joiner");
                  const takerName = e.scorer_name || "Unknown";
                  return (
                    <motion.div
                      key={e.seq}
                      className={`duel-match-feed-row ${forMe ? "duel-match-feed-row--me" : "duel-match-feed-row--them"}`}
                      initial={{ x: forMe ? -24 : 24, opacity: 0 }}
                      animate={{ x: 0, opacity: 1 }}
                      transition={{ duration: 0.25, ease: "easeOut" }}
                    >
                      <span className="duel-match-feed-min">PEN</span>
                      <span className="duel-match-feed-icon">{scored ? "✅" : "❌"}</span>
                      <span className="duel-match-feed-scorer">
                        {takerName} — {scored ? "SCORED" : "MISSED"}
                      </span>
                      <span className="duel-match-feed-team">{forMe ? "YOU" : "OPP"}</span>
                    </motion.div>
                  );
                }

                if (kind === "pens_end") {
                  const homePens = e.payload?.homePens ?? 0;
                  const awayPens = e.payload?.awayPens ?? 0;
                  const myPens = iAmCreator ? homePens : awayPens;
                  const oppPens = iAmCreator ? awayPens : homePens;
                  return (
                    <motion.div
                      key={e.seq}
                      className="duel-match-feed-row duel-match-feed-row--marker"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                    >
                      <span className="duel-match-feed-icon">🏆</span>
                      <span className="duel-match-feed-scorer">
                        Penalties: {myPens}–{oppPens}
                      </span>
                    </motion.div>
                  );
                }

                // kickoff / half_time / full_time — narrative markers.
                const label =
                  kind === "kickoff" ? "Kickoff — game on."
                  : kind === "half_time" ? "Half-time whistle."
                  : kind === "full_time" ? "Full-time. Final whistle."
                  : null;
                if (!label) return null;

                return (
                  <motion.div
                    key={e.seq}
                    className="duel-match-feed-row duel-match-feed-row--marker"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.25 }}
                  >
                    <span className="duel-match-feed-min">{e.minute}&apos;</span>
                    <span className="duel-match-feed-icon">
                      {kind === "kickoff" ? "🏁" : kind === "half_time" ? "⏸" : "🔔"}
                    </span>
                    <span className="duel-match-feed-scorer">{label}</span>
                  </motion.div>
                );
              })
            )}
          </AnimatePresence>
        </div>
      </div>
      )}

      {/* Skip button — hidden once we're revealing */}
      {phase !== "reveal" && phase !== "fullTime" && hasTimeline && (
        <button className="duel-match-skip" onClick={skipToEnd}>
          Skip to result
        </button>
      )}

      {/* Winner reveal overlay */}
      <AnimatePresence>
        {reveal && (
          <motion.div
            className="duel-match-reveal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            {iWon && <ConfettiBurst />}

            <motion.div
              className={`duel-match-reveal-card ${
                iWon ? "duel-match-reveal-card--won"
                  : iLost ? "duel-match-reveal-card--lost"
                  : "duel-match-reveal-card--draw"
              }`}
              initial={{ scale: 0.5, opacity: 0, y: 50, rotateX: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0, rotateX: 0 }}
              transition={{ type: "spring", stiffness: 200, damping: 20, delay: 0.2 }}
            >
              <motion.div
                className="duel-match-reveal-tag"
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4, duration: 0.3 }}
              >
                {iWon ? "VICTORY" : iLost ? "DEFEAT" : "DRAW"}
              </motion.div>

              <motion.div
                className="duel-match-reveal-score"
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 300, damping: 18, delay: 0.5 }}
              >
                <span className="duel-match-reveal-score-num">{myScore}</span>
                <span className="duel-match-reveal-score-dash">–</span>
                <span className="duel-match-reveal-score-num">{oppScore}</span>
              </motion.div>
              {myScore === oppScore && room?.winner && (
                <div className="duel-match-reveal-pens" style={{ fontSize: "0.75rem", opacity: 0.7, marginTop: "0.25rem" }}>
                  Won on penalties
                </div>
              )}

              <div className="duel-match-reveal-teams">
                <span className="duel-match-reveal-team">{myLabel}</span>
                <span className="duel-match-reveal-vs">vs</span>
                <span className="duel-match-reveal-team">{oppLabel}</span>
              </div>

              {iWon && (
                <div className="duel-match-payout">
                  <div className="duel-match-payout-amt">+{payoutMon} MON</div>
                  <div className="duel-match-payout-note">
                    {isSettled
                      ? `Prize delivered · ${payoutMon} MON is in your wallet.`
                      : settlementError
                        ? `Result recorded, payout couldn't settle: ${settlementError}. We'll retry shortly.`
                        : "Settling on-chain, hold tight…"}
                  </div>
                  {isSettled && settlementTx && (
                    <div className="duel-match-payout-tx">
                      tx {String(settlementTx).slice(0, 10)}…{String(settlementTx).slice(-6)}
                    </div>
                  )}
                </div>
              )}

              {isDraw && (
                <div className="duel-match-payout">
                  <div className="duel-match-payout-note">
                    Draw — both stakes have been returned to your wallets.
                  </div>
                </div>
              )}

              <button className="duel-match-back" onClick={onBackToLobby}>
                Back to Lobby
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Team badge for one side of the scoreboard. `flash` briefly pulses the
 * background when that side scores.
 */
function SideBadge({ label, isYou, side, flash, score }) {
  return (
    <motion.div
      className={`duel-match-side duel-match-side--${side} ${flash ? "duel-match-side--flash" : ""}`}
      animate={flash
        ? { scale: [1, 1.12, 0.98, 1.04, 1], borderColor: "rgba(52, 211, 153, 0.7)" }
        : { scale: 1, borderColor: "transparent" }
      }
      transition={{ duration: 0.7, ease: "easeOut" }}
    >
      <div className="duel-match-side-tag">{isYou ? "YOU" : "OPPONENT"}</div>
      <div className="duel-match-side-name" title={label}>{label}</div>
      <div className="duel-match-side-score">
        <motion.span
          key={score}
          initial={{ scale: 2.2, opacity: 0, y: -10 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 15 }}
        >
          {score}
        </motion.span>
      </div>
    </motion.div>
  );
}

/**
 * Circular progress ring representing minutes played. Purely decorative;
 * driven by the same clock as everything else.
 */
function ProgressRing({ minute }) {
  const pct = Math.min(1, minute / 90);
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * pct;

  return (
    <svg className="duel-match-ring" viewBox="0 0 80 80" aria-hidden="true">
      <circle cx="40" cy="40" r={radius} className="duel-match-ring-track" />
      <circle
        cx="40"
        cy="40"
        r={radius}
        className="duel-match-ring-fill"
        strokeDasharray={`${dash} ${circumference}`}
        transform="rotate(-90 40 40)"
      />
    </svg>
  );
}

/**
 * Confetti burst — 60 particles fanning out from the reveal card with varied
 * shapes and physics for a spectacular celebration effect.
 */
function ConfettiBurst() {
  const pieces = useMemo(() => {
    return Array.from({ length: 60 }, (_, i) => {
      const angle = (i / 60) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const radius = 180 + Math.random() * 200;
      const isRibbon = Math.random() > 0.5;
      return {
        id: i,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius - 60 - Math.random() * 100,
        delay: Math.random() * 0.25,
        color: pickColor(i),
        rotate: Math.random() * 720 - 360,
        width: isRibbon ? 4 + Math.random() * 3 : 7 + Math.random() * 4,
        height: isRibbon ? 12 + Math.random() * 10 : 7 + Math.random() * 4,
        borderRadius: isRibbon ? "2px" : "50%",
      };
    });
  }, []);

  return (
    <div className="duel-match-confetti" aria-hidden="true">
      {pieces.map((p) => (
        <motion.span
          key={p.id}
          className="duel-match-confetti-piece"
          style={{
            background: p.color,
            width: p.width,
            height: p.height,
            borderRadius: p.borderRadius,
          }}
          initial={{ x: 0, y: 0, opacity: 0, scale: 0.2, rotate: 0 }}
          animate={{
            x: p.x,
            y: p.y,
            opacity: [0, 1, 1, 0.8, 0],
            scale: [0.2, 1.2, 1, 0.8, 0.4],
            rotate: p.rotate,
          }}
          transition={{ duration: 1.8, delay: p.delay, ease: [0.2, 0.8, 0.4, 1] }}
        />
      ))}
    </div>
  );
}

function pickColor(i) {
  const palette = ["#34d399", "#fbbf24", "#f472b6", "#60a5fa", "#a78bfa", "#f97316", "#22d3ee", "#e879f9"];
  return palette[i % palette.length];
}
