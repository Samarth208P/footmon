"use client";

import { useCallback } from "react";
import { useAppKit } from "@reown/appkit/react";
import { getFlagUrl, canPlayerFillSlot, ratingColor, REROLL_PRICE_MON } from "@/lib/constants";
import PitchView from "./PitchView";
import ShinyText from "./ShinyText";
import { AnimatedItem } from "./AnimatedList";

/**
 * The play/draft screen — roll, pick players, assign to pitch slots.
 */
export default function PlayScreen({ game, contract, isConnected, onSubmit, onLeaderboard, showToast }) {
  const {
    slots, nationCode, nationName, year, squad, filteredSquad,
    rolledThisTurn, selectedPlayer, selectedPlacedSlotIdx,
    filterPos, busy, isSquadComplete, assignedIds, assignedNames,
    roll, assignPlayer, movePlayer,
    setSelectedPlayer, setSelectedPlacedSlotIdx,
    setFilterPos, resetDraft, getTeamStats, getSubmitScore,
  } = game;
  const { open } = useAppKit();

  const stats = getTeamStats();
  const submitScore = getSubmitScore();

  // ── Roll handler ────────────────────────────────────────────────────────
  const handleRoll = useCallback(async () => {
    if (busy) return;
    if (isSquadComplete) {
      onSubmit?.();
      return;
    }
    if (rolledThisTurn && !isConnected) {
      open();
      return;
    }
    try {
      const payFn = rolledThisTurn ? contract.payForRoll : null;
      await roll("full", payFn);
    } catch (err) {
      showToast?.(err.message, "error");
    }
  }, [busy, isSquadComplete, rolledThisTurn, isConnected, open, contract, roll, onSubmit, showToast]);

  const handleReroll = useCallback(async (mode) => {
    if (busy) return;
    if (!isConnected) {
      open();
      return;
    }
    try {
      await roll(mode, contract.payForRoll);
    } catch (err) {
      showToast?.(err.message, "error");
    }
  }, [busy, isConnected, open, contract, roll, showToast]);

  // ── Player click ────────────────────────────────────────────────────────
  const handlePlayerClick = (player) => {
    if (selectedPlayer?.id === player.id) {
      setSelectedPlayer(null);
    } else {
      setSelectedPlayer(player);
      setSelectedPlacedSlotIdx(null);
    }
  };

  // ── Slot click ──────────────────────────────────────────────────────────
  const handleSlotClick = (idx) => {
    const slot = slots[idx];

    // Case A: a squad player is selected — try to place them.
    if (selectedPlayer) {
      if (!slot.player && canPlayerFillSlot(selectedPlayer, slot.pos)) {
        assignPlayer(selectedPlayer, idx);
      } else if (slot.player) {
        showToast?.("Slot occupied — move the player first.", "error");
      } else {
        showToast?.(`${selectedPlayer.name} can't play ${slot.pos}`, "error");
      }
      return;
    }

    // Case B: a placed player is selected — try to move or swap.
    if (selectedPlacedSlotIdx !== null) {
      if (idx === selectedPlacedSlotIdx) {
        setSelectedPlacedSlotIdx(null);
        return;
      }
      const moved = movePlayer(selectedPlacedSlotIdx, idx);
      if (moved) {
        setSelectedPlacedSlotIdx(null);
      } else if (slot.player) {
        // Not a legal swap — re-select this slot instead.
        setSelectedPlacedSlotIdx(idx);
      } else {
        const src = slots[selectedPlacedSlotIdx]?.player;
        showToast?.(src ? `${src.name} can't play ${slot.pos}` : "Can't move there", "error");
      }
      return;
    }

    // Case C: nothing selected — pick up whatever is in this slot.
    if (slot.player) {
      setSelectedPlacedSlotIdx(idx);
    }
  };

  // Highlight target for pitch
  const highlightTarget = selectedPlayer || (selectedPlacedSlotIdx !== null ? slots[selectedPlacedSlotIdx]?.player : null);
  // When moving a placed player, we also want to highlight occupied slots
  // that would form a legal two-way swap.
  const swapSourcePos = selectedPlacedSlotIdx !== null ? slots[selectedPlacedSlotIdx]?.pos : null;

  // Position filter chips
  const allPos = [...new Set(squad.flatMap((p) => p.positions || []))].sort();

  return (
    <section className="screen" style={{ display: "flex" }}>
      {/* Left panel — draft */}
      <aside className="play-left mob-active">
        {nationCode === null ? (
          <div className="draft-empty">
            <div className="draft-empty-icon">{isSquadComplete ? "🏆" : "🎲"}</div>
            <h3 className="draft-empty-title">{isSquadComplete ? "Squad Complete!" : "Draft Next Player"}</h3>
            {isSquadComplete && (
              <div className="draft-empty-score" style={{ color: ratingColor(parseFloat(stats.avg)) }}>{stats.avg}</div>
            )}
            <p className="draft-empty-desc">
              {isSquadComplete
                ? "Your XI is complete. Face 7 opponents — one loss ends the run."
                : rolledThisTurn
                  ? <>Free roll used. Reroll costs <strong>{REROLL_PRICE_MON} MON</strong>.</>
                  : `Pick ${stats.assigned + 1} of 11 — this roll is free.`}
            </p>
            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
              <button className="btn-play-roll" onClick={handleRoll} disabled={busy}>
                {busy ? "Rolling ⚽" : isSquadComplete ? "Enter Tournament ⚽" : rolledThisTurn ? `Reroll 🎲 (${REROLL_PRICE_MON} MON)` : "Roll 🎲"}
              </button>
              <button className="btn-cancel-draft" onClick={resetDraft}>Cancel &amp; Restart</button>
            </div>
          </div>
        ) : (
          <div className="draft-active">
            {/* Drawn card */}
            <div className="drawn-card">
              <div className="drawn-flag">
                <img src={getFlagUrl(nationCode)} alt={nationName} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} />
              </div>
              <div className="drawn-info-wrap">
                <div className="drawn-nation">{nationName}</div>
                <div className="drawn-year">{year}</div>
              </div>
            </div>

            {/* Reroll */}
            <div className="reroll-section">
              <div className="reroll-header">
                <span className="rolls-left-label">{REROLL_PRICE_MON} MON per reroll</span>
                <span className="roll-cost-badge">{REROLL_PRICE_MON} MON</span>
              </div>
              <div className="reroll-btns">
                <button className="btn-reroll" onClick={() => handleReroll("nation")} disabled={busy}>↺ Nation</button>
                <button className="btn-reroll" onClick={() => handleReroll("year")} disabled={busy}>↺ Year</button>
              </div>
            </div>

            {/* Position filters */}
            <div className="player-list-header">Pick a Player</div>
            <div className="pos-filters">
              <button className={`pos-chip ${!filterPos ? "active" : ""}`} onClick={() => setFilterPos(null)}>All</button>
              {allPos.map((p) => (
                <button key={p} className={`pos-chip ${filterPos === p ? "active" : ""}`} onClick={() => setFilterPos(p)}>{p}</button>
              ))}
            </div>

            {/* Player list */}
            <div className="player-list-scroll">
              {filteredSquad.length === 0 ? (
                <div className="player-empty">
                  {squad.length === 0
                    ? "No players loaded. Check your database connection."
                    : "No players match this position"}
                </div>
              ) : filteredSquad.map((p, idx) => {
                const assigned = assignedIds.has(p.id);
                const nameUsed = !assigned && assignedNames.has(p.name);
                const hasSlot = slots.some((s) => !s.player && canPlayerFillSlot(p, s.pos));
                const isSelected = selectedPlayer?.id === p.id;
                const isElite = !!p.isLegendary;
                const rc = isElite ? "#f0c040" : "var(--text2)";

                let rowClass = "player-row";
                if (assigned || nameUsed) rowClass += " player-row--assigned";
                else if (!hasSlot) rowClass += " player-row--disabled";
                else if (isSelected) rowClass += " player-row--selected";

                return (
                  <AnimatedItem
                    key={p.id}
                    index={idx}
                    className={rowClass}
                    style={{ borderLeft: `3px solid ${isElite ? "#f0c040" : "var(--border2)"}` }}
                    onClick={!assigned && !nameUsed && hasSlot ? () => handlePlayerClick(p) : undefined}
                  >
                    <div className="player-row-left">
                      {isElite ? (
                        <ShinyText
                          text={p.name}
                          className="player-name player-name--elite"
                          color="#c2951b"
                          shineColor="#fff3c4"
                          speed={2.4}
                          spread={120}
                        />
                      ) : (
                        <span className="player-name">{p.name}</span>
                      )}
                      <span className="player-pos-tags">{(p.positions || []).join(" / ")}</span>
                    </div>
                    <div className="player-rating-wrap">
                      <div className="player-rating-bar">
                        <div className="player-rating-bar-fill" style={{ width: `${p.rating}%`, background: isElite ? "#f0c040" : "var(--text3)" }} />
                      </div>
                      <span className="player-rating" style={{ color: rc }}>{p.rating}</span>
                    </div>
                  </AnimatedItem>
                );
              })}
            </div>
          </div>
        )}
      </aside>

      {/* Center — pitch */}
      <div className="pitch-wrap">
        <PitchView
          slots={slots}
          highlightPlayer={highlightTarget}
          selectedSlotIdx={selectedPlacedSlotIdx}
          swapSourcePos={swapSourcePos}
          onSlotClick={handleSlotClick}
        />
      </div>

      {/* Right — scorecard */}
      <aside className="play-right">
        <div className="scorecard-header">
          <p className="scorecard-title">Your Squad</p>
          <div className="sc-avg-row">
            <span className="sc-avg" style={{ color: stats.assigned > 0 ? ratingColor(parseFloat(stats.avg)) : "#7fa687" }}>
              {stats.assigned > 0 ? stats.avg : "—"}
            </span>
            <span className="sc-assigned">{stats.assigned} / {stats.total}</span>
          </div>
          <div className="sc-bars">
            <div className="sc-bar-row">
              <span className="sc-bar-label">ATK</span>
              <div className="sc-bar-track"><div className="sc-bar-fill sc-bar-fill--atk" style={{ width: `${stats.attack}%` }} /></div>
              <span className="sc-bar-value">{stats.attack}</span>
            </div>
            <div className="sc-bar-row">
              <span className="sc-bar-label">DEF</span>
              <div className="sc-bar-track"><div className="sc-bar-fill sc-bar-fill--def" style={{ width: `${stats.defense}%` }} /></div>
              <span className="sc-bar-value">{stats.defense}</span>
            </div>
          </div>
        </div>

        <div className="sc-rows">
          {slots.filter((sl) => sl.player).length === 0 ? (
            <div className="sc-empty">No picks yet — roll and place a player.</div>
          ) : (
            slots
              .map((sl, idx) => ({ sl, idx }))
              .filter(({ sl }) => sl.player)
              .map(({ sl, idx }) => {
                const p = sl.player;
                const isElite = !!p.isLegendary;
                const rc = ratingColor(p.rating);
                return (
                  <AnimatedItem
                    key={idx}
                    index={idx}
                    className="sc-row sc-row--filled"
                  >
                    <span className="sc-pos">{sl.pos}</span>
                    {isElite ? (
                      <ShinyText
                        text={p.name}
                        className="sc-name sc-name--elite"
                        color="#c2951b"
                        shineColor="#fff3c4"
                        speed={2.4}
                      />
                    ) : (
                      <span className="sc-name">{p.name}</span>
                    )}
                    <span className="sc-rating" style={{ color: rc }}>{p.rating}</span>
                  </AnimatedItem>
                );
              })
          )}
        </div>

        {isSquadComplete && (
          <div className="sc-complete-badge">
            <span className="sc-complete-icon">✓</span>
            <span>Squad Ready</span>
          </div>
        )}
      </aside>
    </section>
  );
}
