// js/game.js — Core game state and logic

const Game = (() => {

  // ── State ─────────────────────────────────────────────────────────────────
  const state = {
    // Formation screen
    formation: "4-3-3",
    style:     "balanced",   // "defensive" | "balanced" | "attacking"

    // Current roll
    year:        null,
    nationCode:  null,
    nationName:  null,
    squad:       [],         // sorted by rating desc
    selectedPlayer: null,    // selected player in squad list

    // Roll economy
    rollsUsed:   0,          // total rolls this session
    freeRolls:   FREE_ROLLS, // from config.js

    // Team slots  (populated from FORMATIONS on formation change)
    slots: [],               // [{ pos, top, left, player: null|playerObj }]

    // UI
    selectedSlotIdx: null,   // which slot is "active" for player assignment
    selectedPlacedSlotIdx: null, // slot index selected for moving a placed player
    filterPos:       null,   // position filter in player list
    screen:          "formation", // "formation" | "play" | "leaderboard"
    busy:            false,  // true while async ops pending
  };

  // ── Formation helpers ─────────────────────────────────────────────────────

  function buildSlots(formationKey, styleKey) {
    const fmn = FORMATIONS[formationKey];
    let shiftY = 0;
    let scaleX = 1.0;

    if (styleKey === "defensive") {
      shiftY = 4.5;
      scaleX = 0.85;
    } else if (styleKey === "attacking") {
      shiftY = -4.5;
      scaleX = 1.15;
    }

    return fmn.slots.map((s, i) => {
      // Scale left coordinate relative to the vertical centerline (50)
      let newLeft = 50 + (s.left - 50) * scaleX;
      // Cap horizontal limits to keep slots on the grass margins
      newLeft = Math.min(92, Math.max(8, newLeft));

      // GK does not shift up/down or compress/expand horizontally
      let newTop = s.pos === "GK" ? s.top : s.top + shiftY;
      // Cap vertical limits to keep slots on the grass margins
      newTop = Math.min(84, Math.max(10, newTop));

      return {
        pos:    s.pos,
        top:    newTop,
        left:   newLeft,
        player: null,
        id:     i,
      };
    });
  }

  function setFormation(key) {
    state.formation = key;
    state.slots     = buildSlots(key, state.style);
    // Keep previously assigned players if their position still fits
    // (Formation change clears the team for simplicity and fairness)
  }

  function setStyle(style) {
    state.style = style;
    state.slots = buildSlots(state.formation, style);
  }

  // ── Roll logic ────────────────────────────────────────────────────────────

  /**
   * @param {"nation"|"year"|"full"} mode
   * "nation" = Another Nation (keep year)
   * "year"   = Another World Cup (keep nation)
   * "full"   = initial roll
   */
  async function roll(mode = "full") {
    if (state.busy) return;
    state.busy = true;

    const isPaid = state.rollsUsed >= state.freeRolls;

    try {
      if (isPaid) {
        // Pay on-chain first
        if (!WalletManager.isConnected()) {
          throw new Error("Connect your wallet for paid rolls.");
        }
        if (!ContractManager.isAvailable()) {
          throw new Error("Contract not deployed yet. Contact the game owner.");
        }
        showToast("Confirm transaction in MetaMask…", "info");
        await ContractManager.payForRoll();
        showToast("Roll purchased! ✔", "success");
      }

      let rollResult;
      if (mode === "nation") {
        rollResult = await DataManager.roll({
          lockYear:      state.year,
          excludeNation: state.nationCode,
        });
      } else if (mode === "year") {
        rollResult = await DataManager.roll({
          lockNation:  state.nationCode,
          excludeYear: state.year,
        });
      } else {
        rollResult = await DataManager.roll();
      }

      state.year       = rollResult.year;
      state.nationCode = rollResult.nationCode;
      state.nationName = rollResult.nationName;
      state.squad      = rollResult.squad;
      state.rollsUsed++;

      // Reset selection UI state
      state.selectedSlotIdx = null;
      state.selectedPlayer  = null;
      state.filterPos       = null;

    } finally {
      state.busy = false;
    }
  }

  // ── Player assignment ─────────────────────────────────────────────────────

  function canPlayerFillSlot(player, slotPos) {
    const accepted = POSITION_COMPAT[slotPos] || [slotPos];
    return player.positions.some(p => accepted.includes(p));
  }

  function assignPlayer(playerObj, slotIdx) {
    const slot = state.slots[slotIdx];
    if (!slot) return false;
    if (!canPlayerFillSlot(playerObj, slot.pos)) return false;

    // Remove player from any other slot they might already occupy
    state.slots.forEach(s => { if (s.player && s.player.id === playerObj.id) s.player = null; });

    // Save the drafted nation and year from game state onto the player object
    if (state.nationCode) {
      playerObj.draftedNation = state.nationCode;
      playerObj.draftedYear   = state.year;
    }

    // If slot already has a player, remove them first
    slot.player = playerObj;

    // Reset draft state since player is successfully selected
    state.year           = null;
    state.nationCode     = null;
    state.nationName     = null;
    state.squad          = [];
    state.rollsUsed      = 0;
    state.selectedPlayer = null;

    return true;
  }

  function removePlayer(slotIdx) {
    if (state.slots[slotIdx]) state.slots[slotIdx].player = null;
  }

  // ── Score calculation ─────────────────────────────────────────────────────

  function getTeamStats() {
    const filled   = state.slots.filter(s => s.player);
    const total    = state.slots.length;
    const assigned = filled.length;

    if (assigned === 0) return { avg: 0, attack: 0, defense: 0, assigned, total };

    const avg     = filled.reduce((s, sl) => s + sl.player.rating, 0) / assigned;
    const attack  = filled.reduce((s, sl) => s + (sl.player.stats?.att || 0), 0) / assigned;
    const defense = filled.reduce((s, sl) => s + (sl.player.stats?.def || 0), 0) / assigned;

    return { avg: avg.toFixed(1), attack: Math.round(attack), defense: Math.round(defense), assigned, total };
  }

  /** Score submitted to chain = avg × 100 as integer */
  function getSubmitScore() {
    const { avg, assigned, total } = getTeamStats();
    if (assigned < total) return null; // must fill all slots
    return parseFloat(avg);
  }

  // ── Filtered player list ───────────────────────────────────────────────────

  function getFilteredSquad() {
    if (!state.filterPos) return state.squad;
    return state.squad.filter(p => p.positions.includes(state.filterPos));
  }

  // ── Assigned player ids ───────────────────────────────────────────────────
  function getAssignedIds() {
    return new Set(state.slots.filter(s => s.player).map(s => s.player.id));
  }

  return {
    state,
    setFormation, setStyle,
    roll,
    canPlayerFillSlot, assignPlayer, removePlayer,
    getTeamStats, getSubmitScore,
    getFilteredSquad, getAssignedIds,
    buildSlots,
  };
})();
