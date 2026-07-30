// js/main.js — App bootstrap + UI wiring

// ── Toast helper ─────────────────────────────────────────────────────────────
function showToast(msg, type = "info") {
  // Simplify raw Web3 / Ethers transaction error messages
  if (type === "error" && typeof msg === "string") {
    if (msg.includes("ACTION_REJECTED") || msg.includes("user rejected") || msg.includes("User denied")) {
      msg = "Transaction cancelled";
    } else if (msg.includes("insufficient funds")) {
      msg = "Insufficient funds for gas or value";
    } else if (msg.includes("execution reverted")) {
      const match = msg.match(/execution reverted: (.*?)(?:"|'|,|\)|$)/);
      msg = (match && match[1]) ? match[1] : "Transaction reverted on-chain";
    } else {
      // Strip raw ethers action details (action="...", reason="...")
      const actionIdx = msg.indexOf('(action="');
      if (actionIdx !== -1) {
        msg = msg.substring(0, actionIdx).trim();
      }
      if (msg.length > 80) {
        msg = msg.substring(0, 77) + "...";
      }
    }
  }

  const wrap = document.getElementById("toastWrap");
  if (!wrap) return;
  const t = document.createElement("div");
  t.className = `toast toast--${type}`;
  t.textContent = msg;
  wrap.appendChild(t);
  // Animate in
  requestAnimationFrame(() => t.classList.add("toast--show"));
  setTimeout(() => {
    t.classList.remove("toast--show");
    setTimeout(() => t.remove(), 400);
  }, 3500);
}

// ── Rating colour util (used by multiple modules) ────────────────────────────
function ratingBadgeClass(r) {
  if (r >= 90) return "rating--gold";
  if (r >= 80) return "rating--green";
  if (r >= 70) return "rating--white";
  return "rating--gray";
}

function hexToRgba(hex, alpha) {
  if (!hex || !hex.startsWith("#")) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ══════════════════════════════════════════════════════════════════════════════
// DOM refs
// ══════════════════════════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);

const Refs = {
  // Wallet
  btnConnect:     $("btnConnect"),
  walletBadge:    $("walletBadge"),

  // Formation screen
  screenFormation:  $("screenFormation"),
  formationBtns:    document.querySelectorAll(".btn-formation"),
  styleBtns:        document.querySelectorAll(".btn-style"),
  btnStart:         $("btnStart"),
  btnHomeLeaderboard: $("btnHomeLeaderboard"),
  pitchFormation:   $("pitchFormation"),

  // Play screen
  screenPlay:      $("screenPlay"),
  draftEmptyState:  $("draftEmptyState"),
  draftActiveState: $("draftActiveState"),
  btnPlayRoll:      $("btnPlayRoll"),
  btnCancelDraft:   $("btnCancelDraft"),
  drawnFlag:       $("drawnFlag"),
  drawnNation:     $("drawnNation"),
  drawnYear:       $("drawnYear"),
  rollsLeft:       $("rollsLeft"),
  btnNation:       $("btnNation"),
  btnYear:         $("btnYear"),
  rollCostBadge:   $("rollCostBadge"),
  playerList:      $("playerList"),
  posFilters:      $("posFilters"),
  pitchPlay:       $("pitchPlay"),
  // Scorecard
  scAvg:           $("scAvg"),
  scAssigned:      $("scAssigned"),
  scAttack:        $("scAttack"),
  scDefense:       $("scDefense"),
  scRows:          $("scRows"),
  btnSubmit:       $("btnSubmit"),
  btnLeaderboard:  $("btnLeaderboard"),

  // Leaderboard overlay
  leaderboardOverlay: $("leaderboardOverlay"),
  lbBody:             $("lbBody"),
  btnCloseLb:         $("btnCloseLb"),
};

// ══════════════════════════════════════════════════════════════════════════════
// Wallet
// ══════════════════════════════════════════════════════════════════════════════
async function handleConnectWallet() {
  try {
    const addr = await WalletManager.connect();
    ContractManager.init();
    updateWalletUI(addr);
    showToast("Wallet connected ✔", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

function updateWalletUI(addr) {
  if (!addr) {
    Refs.btnConnect.style.display   = "flex";
    Refs.walletBadge.style.display  = "none";
    return;
  }
  Refs.btnConnect.style.display  = "none";
  Refs.walletBadge.style.display = "flex";
  Refs.walletBadge.textContent   = addr.slice(0, 6) + "…" + addr.slice(-4);
}

// ══════════════════════════════════════════════════════════════════════════════
// Formation Screen
// ══════════════════════════════════════════════════════════════════════════════
function initFormationScreen() {
  // Formation buttons
  Refs.formationBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      Refs.formationBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      Game.setFormation(btn.dataset.formation);
      renderFormationPitch();
    });
  });

  // Style buttons
  Refs.styleBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      Refs.styleBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      Game.setStyle(btn.dataset.style);
      renderFormationPitch();
    });
  });

  // Initialise default
  Game.setFormation(Game.state.formation);
  renderFormationPitch();
}

function renderFormationPitch() {
  PitchRenderer.render(Refs.pitchFormation, Game.state.slots, null, () => {});
}

async function startGame() {
  Refs.btnStart.disabled = true;
  Refs.btnStart.textContent = "Rolling…";
  try {
    // Clear slots and draft state for fresh draft progression game
    Game.state.slots = Game.buildSlots(Game.state.formation, Game.state.style);
    Game.state.rollsUsed = 0;
    Game.state.selectedPlayer = null;
    Game.state.selectedPlacedSlotIdx = null;

    await Game.roll("full");
    switchToScreen("play");
    renderPlayScreen();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    Refs.btnStart.disabled = false;
    Refs.btnStart.textContent = "Start Rolling 🎲";
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Play Screen
// ══════════════════════════════════════════════════════════════════════════════
function renderPlayScreen() {
  const s = Game.state;
  const isComplete = s.slots.every(slot => slot.player !== null);

  if (isComplete) {
    Refs.draftEmptyState.style.display  = "flex";
    Refs.draftActiveState.style.display = "none";

    const titleEl = Refs.draftEmptyState.querySelector(".draft-empty-title");
    const descEl  = Refs.draftEmptyState.querySelector(".draft-empty-desc");
    const btnEl   = Refs.btnPlayRoll;
    const iconEl  = Refs.draftEmptyState.querySelector(".draft-empty-icon");

    const avgScore = Game.getTeamStats().avg;

    if (iconEl) iconEl.textContent = "🏆";
    if (titleEl) titleEl.textContent = "Squad Complete!";
    if (descEl) descEl.innerHTML = `Your squad is fully drafted.<br/>Submit your score of <strong>${avgScore}</strong> on-chain.`;
    
    if (btnEl) {
      if (!WalletManager.isConnected()) {
        btnEl.textContent = "Connect Wallet to Submit";
      } else {
        btnEl.textContent = "Submit Score";
      }
      btnEl.disabled = false;
    }
  } else if (s.nationCode === null) {
    Refs.draftEmptyState.style.display  = "flex";
    Refs.draftActiveState.style.display = "none";

    const titleEl = Refs.draftEmptyState.querySelector(".draft-empty-title");
    const descEl  = Refs.draftEmptyState.querySelector(".draft-empty-desc");
    const btnEl   = Refs.btnPlayRoll;
    const iconEl  = Refs.draftEmptyState.querySelector(".draft-empty-icon");

    if (iconEl) iconEl.textContent = "🎲";
    const isPaid  = s.rollsUsed >= s.freeRolls;

    if (isPaid) {
      if (titleEl) titleEl.textContent = "Pay & Roll";
      if (descEl) descEl.innerHTML = `Free rolls used.<br/>Pay <strong>${ROLL_PRICE_MON} MON</strong> to draft next player.`;
      if (btnEl) btnEl.textContent = `Pay & Roll 🎲 (${ROLL_PRICE_MON} MON)`;
    } else {
      const remaining = s.freeRolls - s.rollsUsed;
      if (titleEl) titleEl.textContent = "Draft Next Player";
      if (descEl) descEl.textContent = `Roll to draw a nation. ${remaining} free roll${remaining !== 1 ? "s" : ""} left.`;
      if (btnEl) btnEl.textContent = "Roll 🎲";
    }
    if (btnEl) {
      btnEl.disabled = false;
    }
  } else {
    Refs.draftEmptyState.style.display  = "none";
    Refs.draftActiveState.style.display = "flex";

    // Drawn info
    const iso2 = (ISO3_TO_2[s.nationCode] || s.nationCode.slice(0, 2)).toLowerCase();
    Refs.drawnFlag.innerHTML = `<img src="flags/${iso2}.png" alt="${s.nationName}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" />`;
    Refs.drawnNation.textContent = `${s.nationName}`;
    Refs.drawnYear.textContent   = `${s.year}`;

    updateRollsUI();
    renderPlayerList();
  }

  renderPitch();
  renderScorecard();
}

function updateRollsUI() {
  const s         = Game.state;
  const remaining = Math.max(0, s.freeRolls - s.rollsUsed);
  const isPaid    = s.rollsUsed >= s.freeRolls;

  Refs.rollsLeft.textContent = remaining > 0
    ? `${remaining} free roll${remaining !== 1 ? "s" : ""} left`
    : "Free rolls used";

  Refs.rollCostBadge.style.display = isPaid ? "inline-flex" : "none";
}

// ── Player list ───────────────────────────────────────────────────────────────
function renderPlayerList() {
  const s          = Game.state;
  const assignedIds = Game.getAssignedIds();
  const players    = Game.getFilteredSquad();

  // Position filter chips
  const allPos = [...new Set(s.squad.flatMap(p => p.positions))].sort();
  Refs.posFilters.innerHTML = `
    <button class="pos-chip ${!s.filterPos ? "active" : ""}" data-pos="">All</button>
    ${allPos.map(p => `
      <button class="pos-chip ${s.filterPos === p ? "active" : ""}" data-pos="${p}">${p}</button>
    `).join("")}
  `;
  Refs.posFilters.querySelectorAll(".pos-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      Game.state.filterPos = chip.dataset.pos || null;
      renderPlayerList();
    });
  });

  // Player rows
  Refs.playerList.innerHTML = players.map((p, i) => {
    const assigned = assignedIds.has(p.id);
    const hasCompatibleSlot = s.slots.some(slot => !slot.player && Game.canPlayerFillSlot(p, slot.pos));
    const isSelected = s.selectedPlayer && s.selectedPlayer.id === p.id;
    
    let rowClass = "player-row";
    if (assigned) {
      rowClass += " player-row--assigned";
    } else if (!hasCompatibleSlot) {
      rowClass += " player-row--disabled";
    } else if (isSelected) {
      rowClass += " player-row--selected";
    }

    const rc       = PitchRenderer.ratingColor(p.rating);
    const posStr   = p.positions.join(" / ");
    const badgeBg  = hexToRgba(rc, 0.08);
    const badgeBdr = hexToRgba(rc, 0.15);
    return `
      <div class="${rowClass}" style="border-left: 3px solid ${rc};"
           data-pid="${p.id}" data-pidx="${i}">
        <div class="player-row-left">
          <span class="player-name">${p.name}</span>
          <span class="player-pos-tags">${posStr}</span>
        </div>
        <span class="player-rating" style="color:${rc}; background-color:${badgeBg}; border-color:${badgeBdr};">${p.rating}</span>
      </div>`;
  }).join("") || `<div class="player-empty">No players match this position</div>`;

  Refs.playerList.querySelectorAll(".player-row").forEach(row => {
    if (row.classList.contains("player-row--assigned") || row.classList.contains("player-row--disabled")) return;

    row.addEventListener("click", () => {
      const pid  = row.dataset.pid;
      const player = Game.state.squad.find(p => p.id === pid);
      if (!player) return;
      handlePlayerClick(player);
    });
  });
}

function handlePlayerClick(player) {
  const s = Game.state;

  if (s.selectedPlayer && s.selectedPlayer.id === player.id) {
    // Deselecting — go back to draft panel so they can pick another player
    s.selectedPlayer = null;
    switchMobileTab("draft");
  } else {
    s.selectedPlayer = player;
    s.selectedPlacedSlotIdx = null; // deselect placed slot when selecting squad player
    // Show pitch immediately so compatible slots are visible
    switchMobileTab("pitch");
  }

  renderPitch();
  renderPlayerList();
}

// ── Pitch ─────────────────────────────────────────────────────────────────────
function renderPitch() {
  const s = Game.state;
  
  // Decide which player is being checked for highlighting compatibility on the pitch
  let highlightTarget = null;
  if (s.selectedPlayer) {
    highlightTarget = s.selectedPlayer;
  } else if (s.selectedPlacedSlotIdx !== null) {
    highlightTarget = s.slots[s.selectedPlacedSlotIdx].player;
  }

  PitchRenderer.render(
    Refs.pitchPlay,
    s.slots,
    highlightTarget,
    s.selectedPlacedSlotIdx,
    (idx) => {
      const slot = s.slots[idx];

      if (s.selectedPlayer) {
        // 1. Placing a drafted player from the squad list
        if (!slot.player && Game.canPlayerFillSlot(s.selectedPlayer, slot.pos)) {
          const success = Game.assignPlayer(s.selectedPlayer, idx);
          if (success) {
            renderPlayScreen();
            // On mobile: return to draft tab so user can roll for next player
            switchMobileTab("draft");
          }
        } else {
          if (slot.player) {
            showToast("Slot is already occupied! Move the current player first.", "error");
          } else {
            showToast(`${s.selectedPlayer.name} cannot play as ${slot.pos}`, "error");
          }
        }
      } else if (s.selectedPlacedSlotIdx !== null) {
        // 2. Moving an already placed player
        if (idx === s.selectedPlacedSlotIdx) {
          // Clicked same slot -> deselect
          s.selectedPlacedSlotIdx = null;
          renderPlayScreen();
        } else if (!slot.player && Game.canPlayerFillSlot(s.slots[s.selectedPlacedSlotIdx].player, slot.pos)) {
          // Move player to empty compatible slot
          slot.player = s.slots[s.selectedPlacedSlotIdx].player;
          s.slots[s.selectedPlacedSlotIdx].player = null;
          s.selectedPlacedSlotIdx = null;
          renderPlayScreen();
        } else {
          // Clicked somewhere else. If it's a filled slot, select it instead for moving
          if (slot.player) {
            s.selectedPlacedSlotIdx = idx;
            renderPlayScreen();
          } else {
            s.selectedPlacedSlotIdx = null;
            renderPlayScreen();
          }
        }
      } else {
        // 3. No selection active. Click filled slot to select for moving
        if (slot.player) {
          s.selectedPlacedSlotIdx = idx;
          renderPlayScreen();
        }
      }
    }
  );
}

// ── Scorecard ─────────────────────────────────────────────────────────────────
function renderScorecard() {
  const stats = Game.getTeamStats();

  Refs.scAvg.textContent      = stats.assigned > 0 ? stats.avg : "—";
  Refs.scAvg.style.color      = stats.assigned > 0 ? PitchRenderer.ratingColor(parseFloat(stats.avg)) : "#7fa687";
  Refs.scAssigned.textContent = `${stats.assigned} / ${stats.total}`;
  Refs.scAttack.style.width   = `${stats.attack}%`;
  Refs.scDefense.style.width  = `${stats.defense}%`;

  // Per-position rows
  Refs.scRows.innerHTML = Game.state.slots.map((sl, idx) => {
    const p  = sl.player;
    const rc = p ? PitchRenderer.ratingColor(p.rating) : "";
    return `
      <div class="sc-row" data-idx="${idx}">
        <span class="sc-pos">${sl.pos}</span>
        <span class="sc-name">${p ? PitchRenderer.shortName(p.name) : "—"}</span>
        <span class="sc-rating" style="color:${rc}">${p ? p.rating : ""}</span>
      </div>`;
  }).join("");

  // Submit button state
  const submitScore = Game.getSubmitScore();
  Refs.btnSubmit.disabled = !submitScore || !WalletManager.isConnected();
  Refs.btnSubmit.title    = !WalletManager.isConnected()
    ? "Connect wallet to submit"
    : !submitScore
      ? "Fill all 11 slots to submit"
      : "Submit your score on-chain";
}

// ── Roll buttons ──────────────────────────────────────────────────────────────
async function handleReroll(mode) {
  if (Game.state.busy) return;
  try {
    await Game.roll(mode);
    renderPlayScreen();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ── Submit score ──────────────────────────────────────────────────────────────
async function handleSubmit() {
  const s     = Game.state;
  const score = Game.getSubmitScore();
  if (!score) { showToast("Fill all 11 slots first", "error"); return; }
  if (!WalletManager.isConnected()) { showToast("Connect wallet first", "error"); return; }
  if (!ContractManager.isAvailable()) {
    showToast("Contract not deployed. See DEPLOY.md.", "error");
    return;
  }

  // Find a representative assigned player to get their drafted nation code and year
  const representativeSlot = s.slots.find(sl => sl.player && sl.player.draftedNation);
  const nation = representativeSlot ? representativeSlot.player.draftedNation : "BRA";
  const year   = representativeSlot ? representativeSlot.player.draftedYear : 2002;

  Refs.btnSubmit.disabled = true;
  Refs.btnSubmit.textContent = "Submitting…";

  const btnEl = Refs.btnPlayRoll;
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = "Submitting…";
  }

  try {
    showToast("Confirm transaction in MetaMask…", "info");
    await ContractManager.submitScore(parseFloat(score), nation, year, s.formation);
    showToast(`Score ${score} submitted on-chain ✔`, "success");
    switchToScreen("formation");
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    Refs.btnSubmit.disabled = false;
    Refs.btnSubmit.textContent = "Submit Score";
    if (btnEl) {
      btnEl.disabled = false;
    }
    renderPlayScreen();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Leaderboard Overlay
// ══════════════════════════════════════════════════════════════════════════════
function openLeaderboard() {
  Refs.leaderboardOverlay.classList.add("open");
  Refs.lbBody.innerHTML = "";
  LeaderboardManager.refresh(Refs.lbBody);
}

function closeLeaderboard() {
  Refs.leaderboardOverlay.classList.remove("open");
}

// ══════════════════════════════════════════════════════════════════════════════
// Screen switching
// ══════════════════════════════════════════════════════════════════════════════
function switchToScreen(screen) {
  Game.state.screen = screen;
  Refs.screenFormation.style.display = screen === "formation" ? "flex"   : "none";
  Refs.screenPlay.style.display      = screen === "play"      ? "flex"   : "none";
  // On play screen, ensure draft panel is visible by default on mobile
  if (screen === "play") switchMobileTab("draft");
}

// ── Mobile tab switching ──────────────────────────────────────────────────────
function isMobile() {
  return window.innerWidth <= 680;
}

function switchMobileTab(tab) {
  if (!isMobile()) return;
  // Toggle .mob-active on the three panels
  const playLeft   = document.querySelector(".play-left");
  const pitchWrap  = document.querySelector(".pitch-wrap");
  const playRight  = document.querySelector(".play-right");
  if (!playLeft || !pitchWrap || !playRight) return;

  playLeft.classList.toggle("mob-active",  tab === "draft");
  pitchWrap.classList.toggle("mob-active", tab === "pitch");
  playRight.classList.toggle("mob-active", tab === "stats");

  // Sync tab button active state
  document.querySelectorAll(".mob-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Bootstrap
// ══════════════════════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  // Wallet
  Refs.btnConnect.addEventListener("click", handleConnectWallet);

  // Formation screen
  initFormationScreen();
  Refs.btnStart.addEventListener("click", startGame);
  if (Refs.btnHomeLeaderboard) {
    Refs.btnHomeLeaderboard.addEventListener("click", openLeaderboard);
  }

  // Mobile tabs
  document.querySelectorAll(".mob-tab").forEach(btn => {
    btn.addEventListener("click", () => switchMobileTab(btn.dataset.tab));
  });

  // Play screen — reroll buttons
  Refs.btnNation.addEventListener("click", () => handleReroll("nation"));
  Refs.btnYear.addEventListener("click",   () => handleReroll("year"));
  Refs.btnPlayRoll.addEventListener("click", handlePlayRoll);
  if (Refs.btnCancelDraft) {
    Refs.btnCancelDraft.addEventListener("click", () => switchToScreen("formation"));
  }

  // Submit + Leaderboard
  Refs.btnSubmit.addEventListener("click", handleSubmit);
  Refs.btnLeaderboard.addEventListener("click", openLeaderboard);
  Refs.btnCloseLb.addEventListener("click", closeLeaderboard);

  // Close overlay on backdrop click
  Refs.leaderboardOverlay.addEventListener("click", e => {
    if (e.target === Refs.leaderboardOverlay) closeLeaderboard();
  });

  // Wallet events
  document.addEventListener("wallet:disconnected",   () => updateWalletUI(null));
  document.addEventListener("wallet:accountChanged", e => updateWalletUI(e.detail));

  // Initialise screens
  switchToScreen("formation");

  // Check if MetaMask is already connected
  if (WalletManager.isMetaMaskAvailable() && window.ethereum.selectedAddress) {
    handleConnectWallet().catch(() => {});
  }
});

async function handlePlayRoll() {
  if (Game.state.busy) return;

  const isComplete = Game.state.slots.every(slot => slot.player !== null);
  if (isComplete) {
    if (!WalletManager.isConnected()) {
      await handleConnectWallet();
    } else {
      await handleSubmit();
    }
    return;
  }

  Refs.btnPlayRoll.disabled = true;
  Refs.btnPlayRoll.textContent = "Rolling…";
  try {
    await Game.roll("full");
    renderPlayScreen();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    Refs.btnPlayRoll.disabled = false;
    renderPlayScreen();
  }
}
