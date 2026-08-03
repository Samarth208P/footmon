"use client";

import { motion } from "motion/react";

/**
 * Renders a full 5-per-side (plus sudden-death) shootout row.
 *
 * Circles are keyed by kick number, so the row grows on the right for
 * sudden death without reshuffling the first five. During live playback,
 * `revealed` counts how many kicks have been unveiled — pending kicks
 * render as an empty outlined circle, taken kicks as filled green/red.
 */
export default function PenaltyShootout({ pens, revealed, youLabel, themLabel, youScore, themScore, done }) {
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
