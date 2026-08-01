"use client";

import { useCallback, useState } from "react";
import { SQUAD_TURNS, REROLL_PRICE_MON, buildSlots, canPlayerFillSlot } from "@/lib/constants";

/**
 * Hook managing the core solo game state: formation, rolls, player assignment.
 */
export function useGame() {
  const [formation, setFormationKey] = useState("4-3-3");
  const [style, setStyleKey] = useState("balanced");
  const [slots, setSlots] = useState(() => buildSlots("4-3-3", "balanced"));

  // Current roll state
  const [nationCode, setNationCode] = useState(null);
  const [nationName, setNationName] = useState(null);
  const [year, setYear] = useState(null);
  const [squad, setSquad] = useState([]);
  const [rolledThisTurn, setRolledThisTurn] = useState(false);

  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [selectedPlacedSlotIdx, setSelectedPlacedSlotIdx] = useState(null);
  const [filterPos, setFilterPos] = useState(null);
  const [busy, setBusy] = useState(false);
  const [screen, setScreen] = useState("formation");
  // Tournament simulate result — populated when the user hits "Enter
  // Tournament" and switches the shell into the match-visualization screen.
  const [matchResult, setMatchResult] = useState(null);

  // ── Formation ───────────────────────────────────────────────────────────

  const setFormation = useCallback((key) => {
    setFormationKey(key);
    setSlots(buildSlots(key, style));
  }, [style]);

  const setStyle = useCallback((s) => {
    setStyleKey(s);
    setSlots(buildSlots(formation, s));
  }, [formation]);

  // ── Roll ────────────────────────────────────────────────────────────────

  /**
   * @param {"full"|"nation"|"year"} mode
   * @param {function} payForRoll - contract pay function (for rerolls)
   */
  const roll = useCallback(async (mode = "full", payForRoll = null) => {
    if (busy) return;
    setBusy(true);

    const isPaid = rolledThisTurn;

    try {
      if (isPaid && payForRoll) {
        await payForRoll(REROLL_PRICE_MON);
      }

      const params = new URLSearchParams();
      if (mode === "nation") {
        if (year) params.set("lockYear", year);
        if (nationCode) params.set("excludeNation", nationCode);
      } else if (mode === "year") {
        if (nationCode) params.set("lockNation", nationCode);
        if (year) params.set("excludeYear", year);
      }

      const url = `/api/roll${params.toString() ? "?" + params : ""}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Roll failed (${res.status})`);
      }

      const data = await res.json();
      console.log("[useGame] Roll response:", data);
      setYear(data.year);
      setNationCode(data.nationCode);
      setNationName(data.nationName);
      setSquad(data.squad || []);
      setRolledThisTurn(true);
      setSelectedPlayer(null);
      setFilterPos(null);
    } catch (err) {
      console.error("[useGame] Roll error:", err);
      throw err;
    } finally {
      setBusy(false);
    }
  }, [busy, rolledThisTurn, year, nationCode]);

  // ── Assign player to slot ───────────────────────────────────────────────

  const assignPlayer = useCallback((player, slotIdx) => {
    setSlots((prev) => {
      const target = prev[slotIdx];
      if (!target || !canPlayerFillSlot(player, target.pos)) return prev;

      // Stamp draft info
      const stamped = { ...player, draftedNation: nationCode, draftedYear: year };

      return prev.map((s, i) => {
        if (i === slotIdx) return { ...s, player: stamped };
        // Clear the player from any other slot (avoids mutating shared refs)
        if (s.player && s.player.id === player.id) return { ...s, player: null };
        return s;
      });
    });

    // Reset draft state for next turn
    setYear(null);
    setNationCode(null);
    setNationName(null);
    setSquad([]);
    setRolledThisTurn(false);
    setSelectedPlayer(null);
  }, [nationCode, year]);

  // ── Move / swap a placed player ─────────────────────────────────────────

  /**
   * Move a player from one slot to another. If the destination is empty,
   * it's a simple move. If the destination has a player and both players
   * are compatible with the other's position, the two are swapped.
   * Returns true on success, false if the move is not legal.
   */
  const movePlayer = useCallback((fromIdx, toIdx) => {
    if (fromIdx === toIdx) return false;
    const from = slots[fromIdx];
    const to = slots[toIdx];
    if (!from || !to || !from.player) return false;

    // Move into empty slot
    if (!to.player) {
      if (!canPlayerFillSlot(from.player, to.pos)) return false;
      setSlots((prev) => prev.map((s, i) => {
        if (i === fromIdx) return { ...s, player: null };
        if (i === toIdx) return { ...s, player: from.player };
        return s;
      }));
      return true;
    }

    // Swap — both players must fit each other's positions
    if (!canPlayerFillSlot(from.player, to.pos) || !canPlayerFillSlot(to.player, from.pos)) {
      return false;
    }
    setSlots((prev) => prev.map((s, i) => {
      if (i === fromIdx) return { ...s, player: to.player };
      if (i === toIdx) return { ...s, player: from.player };
      return s;
    }));
    return true;
  }, [slots]);

  // ── Stats ───────────────────────────────────────────────────────────────

  const getTeamStats = useCallback(() => {
    const filled = slots.filter((s) => s.player);
    const total = slots.length;
    const assigned = filled.length;
    if (assigned === 0) return { avg: "0.0", attack: 0, defense: 0, assigned, total };

    const avg = filled.reduce((s, sl) => s + sl.player.rating, 0) / assigned;
    const attack = filled.reduce((s, sl) => s + (sl.player.attack ?? 0), 0) / assigned;
    const defense = filled.reduce((s, sl) => s + (sl.player.defense ?? 0), 0) / assigned;

    return { avg: avg.toFixed(1), attack: Math.round(attack), defense: Math.round(defense), assigned, total };
  }, [slots]);

  const isSquadComplete = slots.every((s) => s.player !== null);

  const getSubmitScore = useCallback(() => {
    if (!isSquadComplete) return null;
    const filled = slots.filter((s) => s.player);
    return (filled.reduce((s, sl) => s + sl.player.rating, 0) / filled.length).toFixed(1);
  }, [slots, isSquadComplete]);

  // ── Reset ───────────────────────────────────────────────────────────────

  const resetDraft = useCallback(() => {
    setSlots(buildSlots(formation, style));
    setYear(null);
    setNationCode(null);
    setNationName(null);
    setSquad([]);
    setRolledThisTurn(false);
    setSelectedPlayer(null);
    setSelectedPlacedSlotIdx(null);
    setFilterPos(null);
    setScreen("formation");
    setMatchResult(null);
  }, [formation, style]);

  // ── Filtered squad ──────────────────────────────────────────────────────

  const filteredSquad = filterPos
    ? squad.filter((p) => p.positions?.includes(filterPos))
    : squad;

  const assignedIds = new Set(slots.filter((s) => s.player).map((s) => s.player.id));

  return {
    // State
    formation,
    style,
    slots,
    nationCode,
    nationName,
    year,
    squad,
    filteredSquad,
    rolledThisTurn,
    selectedPlayer,
    selectedPlacedSlotIdx,
    filterPos,
    busy,
    screen,
    matchResult,
    isSquadComplete,
    assignedIds,

    // Actions
    setFormation,
    setStyle,
    roll,
    assignPlayer,
    movePlayer,
    setSelectedPlayer,
    setSelectedPlacedSlotIdx,
    setFilterPos,
    setScreen,
    setMatchResult,
    resetDraft,
    getTeamStats,
    getSubmitScore,
  };
}
