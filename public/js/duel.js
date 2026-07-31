/**
 * FootMon — 1v1 Draft Duels
 * Cross-device/public-internet transport via Next API routes backed by Supabase.
 */

const DuelManager = (() => {
  const DUEL_FORMATION = "4-3-3";
  const DUEL_STYLE = "balanced";
  const CHALLENGE_POLL_MS = 500;
  const EVENT_POLL_MS = 250;

  const state = {
    instanceId: `duel_${Math.random().toString(36).slice(2, 10)}`,
    myAddress: null,
    sessionWallet: null,
    activeDuel: null,
    pendingPickPlayer: null,
    challengePollTimer: null,
    eventPollTimer: null,
  };

  const Refs = {};

  function init() {
    cacheRefs();
    bindEvents();
    setupSessionWallet();
    refreshWalletState();
    initRelay();
    renderLobby([]);
  }

  function cacheRefs() {
    Refs.btnDuelMode = document.getElementById("navDuelMode");
    Refs.btnSinglePlayer = document.getElementById("navSinglePlayer");
    Refs.screenLobby = document.getElementById("screenDuelLobby");
    Refs.screenPlay = document.getElementById("screenDuelPlay");
    Refs.screenFormation = document.getElementById("screenFormation");
    Refs.screenSinglePlay = document.getElementById("screenPlay");
    Refs.inputStake = document.getElementById("inputDuelStake");
    Refs.btnCreate = document.getElementById("btnCreateDuel");
    Refs.btnRefresh = document.getElementById("btnRefreshLobby");
    Refs.challengesList = document.getElementById("duelChallengesList");

    Refs.turnBanner = document.getElementById("duelTurnBanner");
    Refs.turnText = document.getElementById("duelTurnText");
    Refs.btnRoll = document.getElementById("btnDuelRoll");
    Refs.rollsLeft = document.getElementById("duelRollsLeft");
    Refs.costBadge = document.getElementById("duelRollCostBadge");
    Refs.btnRerollNation = document.getElementById("btnDuelRerollNation");
    Refs.btnRerollYear = document.getElementById("btnDuelRerollYear");
    Refs.draftEmptyState = document.getElementById("duelDraftEmptyState");
    Refs.draftActiveState = document.getElementById("duelDraftActiveState");
    Refs.drawnFlag = document.getElementById("duelDrawnFlag");
    Refs.drawnNation = document.getElementById("duelDrawnNation");
    Refs.drawnYear = document.getElementById("duelDrawnYear");
    Refs.playerList = document.getElementById("duelPlayerList");
    Refs.btnCancel = document.getElementById("btnDuelCancel");

    Refs.myAvg = document.getElementById("duelMyAvg");
    Refs.myAttack = document.getElementById("duelMyAttack");
    Refs.myDefense = document.getElementById("duelMyDefense");
    Refs.myAttackBar = document.getElementById("duelMyAttackBar");
    Refs.opAvg = document.getElementById("duelOpAvg");
    Refs.opAttack = document.getElementById("duelOpAttack");
    Refs.opDefense = document.getElementById("duelOpDefense");
    Refs.opAttackBar = document.getElementById("duelOpAttackBar");
  }

  function bindEvents() {
    if (Refs.btnDuelMode) Refs.btnDuelMode.addEventListener("click", () => switchMode("duel"));
    if (Refs.btnSinglePlayer) Refs.btnSinglePlayer.addEventListener("click", () => switchMode("single"));
    if (Refs.btnCreate) Refs.btnCreate.addEventListener("click", handleCreateChallenge);
    if (Refs.btnRefresh) Refs.btnRefresh.addEventListener("click", refreshLobby);
    if (Refs.btnCancel) Refs.btnCancel.addEventListener("click", quitActiveDuel);
    if (Refs.btnRoll) Refs.btnRoll.addEventListener("click", () => handleDuelRoll("full"));
    if (Refs.btnRerollNation) Refs.btnRerollNation.addEventListener("click", () => handleDuelRoll("nation"));
    if (Refs.btnRerollYear) Refs.btnRerollYear.addEventListener("click", () => handleDuelRoll("year"));

    document.addEventListener("wallet:accountChanged", (e) => {
      state.myAddress = e.detail || null;
      if (state.activeDuel) renderDuelBoard();
      if (Refs.screenLobby && Refs.screenLobby.style.display !== "none") {
        refreshLobby();
      }
    });

    document.addEventListener("wallet:disconnected", () => {
      if (state.activeDuel) return;
      state.myAddress = null;
      stopChallengePolling();
      stopEventPolling();
      renderLobby([]);
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stopChallengePolling();
        stopEventPolling();
      } else {
        if (Refs.screenLobby && Refs.screenLobby.style.display !== "none") {
          startChallengePolling();
          refreshLobby();
        }
        if (state.activeDuel) {
          startEventPolling();
          pollEvents();
        }
      }
    });
  }

  function setupSessionWallet() {
    const key = sessionStorage.getItem("fm_session_key");
    if (key) {
      state.sessionWallet = new ethers.Wallet(key);
      return;
    }
    const wallet = ethers.Wallet.createRandom();
    sessionStorage.setItem("fm_session_key", wallet.privateKey);
    state.sessionWallet = wallet;
  }

  function refreshWalletState() {
    state.myAddress = WalletManager.getAddress();
  }

  const WS_API_KEY = "VCXCEuvhGcBDP7XhiJJUDvR1e1D3eiVjgZ9VRiaV";
  let lobbySocket = null;
  let duelSocket = null;
  let receivedEvents = [];

  function initRelay() {
    try {
      lobbySocket = new WebSocket(`wss://demo.piesocket.com/v3/footmon_lobby?api_key=${WS_API_KEY}&notify_self=1`);
      lobbySocket.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "challenge_created" || msg.type === "challenge_joined") {
            handleRelayMessage(msg);
          }
        } catch (err) {}
      };
    } catch (e) {
      console.error("Lobby relay init failed", e);
    }

    window.addEventListener("storage", (e) => {
      if (e.key === "fm_relay_event") {
        try {
          const msg = JSON.parse(e.newValue);
          handleRelayMessage(msg);
        } catch (err) {}
      }
    });
  }

  function handleRelayMessage(msg) {
    if (msg.type === "challenge_created") {
      let challenges = JSON.parse(localStorage.getItem("fm_challenges") || "[]");
      if (!challenges.some(c => c.duel_id === msg.challenge.duel_id)) {
        challenges.push(msg.challenge);
        localStorage.setItem("fm_challenges", JSON.stringify(challenges));
      }
    }
    if (msg.type === "challenge_joined") {
      let challenges = JSON.parse(localStorage.getItem("fm_challenges") || "[]");
      const c = challenges.find(item => item.duel_id === msg.duelId);
      if (c) {
        c.joiner = msg.joiner;
        c.status = "active";
        localStorage.setItem("fm_challenges", JSON.stringify(challenges));
      }
    }
    if (msg.type === "duel_event") {
      if (!receivedEvents.some(ev => ev.id === msg.event.id)) {
        receivedEvents.push(msg.event);
      }
    }
  }

  function connectDuelSocket(duelId) {
    if (duelSocket) return;
    try {
      duelSocket = new WebSocket(`wss://demo.piesocket.com/v3/footmon_duel_${duelId}?api_key=${WS_API_KEY}&notify_self=1`);
      duelSocket.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "duel_event") {
            handleRelayMessage(msg);
          }
        } catch (err) {}
      };
    } catch (e) {
      console.error("Duel socket init failed", e);
    }
  }

  async function apiFetch(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      cache: "no-store",
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || payload.details || `Request failed: ${response.status}`);
    }
    return payload;
  }

  function switchMode(mode) {
    if (mode === "duel") {
      if (Refs.btnDuelMode) Refs.btnDuelMode.classList.add("active");
      if (Refs.btnSinglePlayer) Refs.btnSinglePlayer.classList.remove("active");
      if (Refs.screenFormation) Refs.screenFormation.style.display = "none";
      if (Refs.screenSinglePlay) Refs.screenSinglePlay.style.display = "none";

      if (state.activeDuel) {
        if (Refs.screenLobby) Refs.screenLobby.style.display = "none";
        if (Refs.screenPlay) Refs.screenPlay.style.display = "flex";
        stopChallengePolling();
        startEventPolling();
        renderDuelBoard();
      } else {
        if (Refs.screenLobby) Refs.screenLobby.style.display = "flex";
        if (Refs.screenPlay) Refs.screenPlay.style.display = "none";
        startChallengePolling();
        refreshLobby();
      }
      return;
    }

    if (Refs.btnSinglePlayer) Refs.btnSinglePlayer.classList.add("active");
    if (Refs.btnDuelMode) Refs.btnDuelMode.classList.remove("active");
    if (Refs.screenLobby) Refs.screenLobby.style.display = "none";
    if (Refs.screenPlay) Refs.screenPlay.style.display = "none";

    stopChallengePolling();
    stopEventPolling();

    const appState = typeof Game !== "undefined" ? Game.state : null;
    if (appState && (appState.busy || appState.screen === "play")) {
      if (Refs.screenSinglePlay) Refs.screenSinglePlay.style.display = "flex";
    } else {
      if (Refs.screenFormation) Refs.screenFormation.style.display = "flex";
      if (typeof renderFormationPitch === "function") renderFormationPitch();
    }
  }

  function startChallengePolling() {
    stopChallengePolling();
    state.challengePollTimer = setInterval(refreshLobby, CHALLENGE_POLL_MS);
  }

  function stopChallengePolling() {
    if (!state.challengePollTimer) return;
    clearInterval(state.challengePollTimer);
    state.challengePollTimer = null;
  }

  function startEventPolling() {
    stopEventPolling();
    state.eventPollTimer = setInterval(pollEvents, EVENT_POLL_MS);
  }

  function stopEventPolling() {
    if (!state.eventPollTimer) return;
    clearInterval(state.eventPollTimer);
    state.eventPollTimer = null;
  }

  async function refreshLobby() {
    refreshWalletState();
    if (!WalletManager.isConnected()) {
      renderLobby([]);
      return;
    }

    try {
      const { challenges } = await apiFetch("/api/duels/challenges");
      let localList = JSON.parse(localStorage.getItem("fm_challenges") || "[]");
      const combined = [...(challenges || [])];
      localList.forEach(lc => {
        if (!combined.some(c => c.duel_id === lc.duel_id)) {
          combined.push(lc);
        }
      });
      renderLobby(combined);
    } catch (err) {
      let localList = JSON.parse(localStorage.getItem("fm_challenges") || "[]");
      renderLobby(localList);
    }
  }

  function renderLobby(challenges) {
    if (!Refs.challengesList) return;

    if (!WalletManager.isConnected()) {
      Refs.challengesList.innerHTML = `<div class="challenges-empty">Connect your wallet to browse public duel challenges.</div>`;
      return;
    }

    const activeChallenges = (challenges || []).filter((challenge) => (
      challenge.creator && challenge.status === "open"
    ));

    if (!activeChallenges.length) {
      Refs.challengesList.innerHTML = `<div class="challenges-empty">No active challenges. Create one above!</div>`;
      return;
    }

    Refs.challengesList.innerHTML = activeChallenges.map((challenge) => `
      <div class="duel-card">
        <div class="duel-card-left">
          <span class="duel-card-addr">Creator: ${shortAddr(challenge.creator)}</span>
          <span class="duel-card-stake">${challenge.stake} MON</span>
        </div>
        <button
          class="btn-join-duel"
          data-id="${challenge.duel_id}"
          data-creator="${challenge.creator}"
          data-stake="${challenge.stake}"
        >
          Join Duel
        </button>
      </div>
    `).join("");

    Refs.challengesList.querySelectorAll(".btn-join-duel").forEach((button) => {
      button.addEventListener("click", () => {
        joinChallenge(button.dataset.id, button.dataset.creator, parseFloat(button.dataset.stake));
      });
    });
  }

  function createDuelSlots() {
    return Game.buildSlots(DUEL_FORMATION, DUEL_STYLE).map((slot, idx) => ({
      ...slot,
      id: idx,
      player: null,
    }));
  }

  function currentUserTurn(duel) {
    return (duel.turn === "creator" && duel.isCreator) || (duel.turn === "joiner" && !duel.isCreator);
  }

  function nextTurn(turn) {
    return turn === "creator" ? "joiner" : "creator";
  }

  async function handleCreateChallenge() {
    refreshWalletState();
    if (!WalletManager.isConnected()) {
      showToast("Please connect wallet first", "info");
      return;
    }

    const stake = parseFloat(Refs.inputStake.value);
    if (Number.isNaN(stake) || stake <= 0) {
      showToast("Please enter a valid MON stake", "error");
      return;
    }

    try {
      showToast("Confirm staking transaction in MetaMask…", "info");
      const signer = WalletManager.getSigner();
      const target = CONTRACT_ADDRESS || state.myAddress;
      const tx = await signer.sendTransaction({
        to: target,
        value: ethers.parseEther(stake.toString()),
      });
      await tx.wait();

      const duelId = `duel_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const { challenge } = await apiFetch("/api/duels/challenges", {
        method: "POST",
        body: JSON.stringify({
          duelId,
          creator: state.myAddress,
          stake,
          sessionPubKey: state.sessionWallet.address,
        }),
      });

      startDuelState({
        id: challenge.duel_id,
        creator: challenge.creator,
        joiner: challenge.joiner,
        stake: parseFloat(challenge.stake),
        isCreator: true,
        status: challenge.joiner ? "active" : "waiting",
      });
      showToast("Challenge created! Waiting for an opponent.", "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  async function joinChallenge(duelId, creator, stake) {
    refreshWalletState();
    if (!WalletManager.isConnected()) {
      showToast("Please connect wallet first", "info");
      return;
    }

    try {
      showToast(`Staking ${stake} MON to join duel…`, "info");
      const signer = WalletManager.getSigner();
      const target = CONTRACT_ADDRESS || creator;
      const tx = await signer.sendTransaction({
        to: target,
        value: ethers.parseEther(stake.toString()),
      });
      await tx.wait();

      const { challenge } = await apiFetch(`/api/duels/challenges/${duelId}/join`, {
        method: "POST",
        body: JSON.stringify({ joiner: state.myAddress }),
      });

      startDuelState({
        id: challenge.duel_id,
        creator: challenge.creator,
        joiner: challenge.joiner,
        stake: parseFloat(challenge.stake),
        isCreator: false,
        status: "active",
      });
      showToast("Joined duel successfully! ✔", "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  function startDuelState(duel) {
    state.pendingPickPlayer = null;
    state.activeDuel = {
      ...duel,
      turn: "creator",
      rollsUsed: 0,
      freeRolls: FREE_ROLLS,
      drawnNation: null,
      drawnYear: null,
      candidates: [],
      mySlots: createDuelSlots(),
      opSlots: createDuelSlots(),
      lastEventId: 0,
    };

    connectDuelSocket(duel.id);

    stopChallengePolling();
    if (Refs.screenLobby) Refs.screenLobby.style.display = "none";
    if (Refs.screenPlay) Refs.screenPlay.style.display = "flex";
    startEventPolling();
    pollEvents().catch(() => {});
    renderDuelBoard();
  }

  async function sendEvent(type, payload) {
    if (!state.activeDuel) return null;
    const { event } = await apiFetch("/api/duels/events", {
      method: "POST",
      body: JSON.stringify({
        duelId: state.activeDuel.id,
        sender: state.instanceId,
        type,
        payload,
      }),
    });
    return event;
  }

  async function pollEvents() {
    const duel = state.activeDuel;
    if (!duel) return;

    try {
      const { events } = await apiFetch(`/api/duels/events?duelId=${encodeURIComponent(duel.id)}&after=${duel.lastEventId || 0}`);
      (events || []).forEach(handleEventRecord);

      if (duel.status === "waiting") {
        const { challenge } = await apiFetch(`/api/duels/challenges/${encodeURIComponent(duel.id)}`);
        if (challenge?.joiner && duel.status !== "active") {
          duel.joiner = challenge.joiner;
          duel.status = "active";
          duel.turn = "creator";
          renderDuelBoard();
        }
      }
    } catch (err) {
      console.error("[Duel] Poll failed", err);
    }
  }

  function handleEventRecord(event) {
    const duel = state.activeDuel;
    if (!duel || event.duel_id !== duel.id) return;
    duel.lastEventId = Math.max(duel.lastEventId || 0, event.id || 0);

    if (event.sender === state.instanceId) return;

    const payload = event.payload || {};
    if (event.type === "challenge_joined") {
      duel.joiner = payload.joiner;
      duel.status = "active";
      duel.turn = "creator";
      renderDuelBoard();
      return;
    }

    if (event.type === "roll_result") {
      state.pendingPickPlayer = null;
      duel.status = "active";
      duel.drawnNation = payload.nation;
      duel.drawnYear = payload.year;
      duel.candidates = payload.candidates || [];
      duel.rollsUsed = payload.rollsUsed || 0;
      renderDuelBoard();
      return;
    }

    if (event.type === "pick_player") {
      const slot = duel.opSlots[payload.slotIndex];
      if (slot) slot.player = payload.player;
      state.pendingPickPlayer = null;
      duel.drawnNation = null;
      duel.drawnYear = null;
      duel.candidates = [];
      duel.rollsUsed = 0;
      duel.turn = nextTurn(duel.turn);
      renderDuelBoard();
      checkDuelCompletion();
      return;
    }

    if (event.type === "duel_quit") {
      const duel = state.activeDuel;
      const totalPot = (duel ? duel.stake * 2 : 0).toFixed(3);
      const winnerShare = (duel ? duel.stake * 2 * 0.7 : 0).toFixed(3);
      const houseCut = (duel ? duel.stake * 2 * 0.3 : 0).toFixed(3);

      state.pendingPickPlayer = null;
      stopEventPolling();

      showCustomModal({
        tag: "🎁 OPPONENT FORFEITED",
        icon: "🏆",
        title: "Opponent Quit!",
        subtitle: "Your opponent left the match. You win by forfeit!",
        boxHtml: `
          <div class="modal-stat-row"><span>Total Pot Staked</span><span class="modal-stat-val">${totalPot} MON</span></div>
          <div class="modal-stat-row"><span>Your Winnings (70%)</span><span class="modal-stat-val green">${winnerShare} MON</span></div>
          <div class="modal-stat-row"><span>House Platform Fee (30%)</span><span class="modal-stat-val purple">${houseCut} MON</span></div>
        `,
        primaryBtnText: `Claim ${winnerShare} MON Winnings 🎉`,
        primaryBtnAction: async () => {
          try {
            showToast(`Transferring ${winnerShare} MON prize to your wallet…`, "info");
            const signer = WalletManager.getSigner();
            const target = state.myAddress || CONTRACT_ADDRESS;
            const tx = await signer.sendTransaction({
              to: target,
              value: ethers.parseEther(winnerShare.toString()),
            });
            await tx.wait();
            showToast(`Successfully claimed ${winnerShare} MON prize! 🎉`, "success");
          } catch (err) {
            showToast(err.message || "Claim cancelled", "error");
          }
          state.activeDuel = null;
          switchMode("duel");
        }
      });
      return;
    }
  }

  async function handleDuelRoll(mode) {
    if (state.busyAction) return;
    const duel = state.activeDuel;
    if (!duel || duel.status !== "active") return;
    if (!currentUserTurn(duel)) {
      showToast("Wait for opponent's turn", "error");
      return;
    }

    const isPaid = duel.rollsUsed >= duel.freeRolls;
    if (isPaid) {
      try {
        showToast(`Confirming ${ROLL_PRICE_MON} MON paid roll in MetaMask…`, "info");
        const signer = WalletManager.getSigner();
        const target = CONTRACT_ADDRESS || state.myAddress;
        const tx = await signer.sendTransaction({
          to: target,
          value: ethers.parseEther(ROLL_PRICE_MON.toString()),
        });
        await tx.wait();
        showToast("Paid roll transaction successful! 🎲", "success");
      } catch (err) {
        showToast(err.message || "Paid roll transaction cancelled", "error");
        return;
      }
    }

    try {
      let rollResult;
      if (mode === "nation") {
        rollResult = await DataManager.roll({
          lockYear: duel.drawnYear,
          excludeNation: duel.drawnNation,
        });
      } else if (mode === "year") {
        rollResult = await DataManager.roll({
          lockNation: duel.drawnNation,
          excludeYear: duel.drawnYear,
        });
      } else {
        rollResult = await DataManager.roll({});
      }

      duel.rollsUsed += 1;
      duel.drawnNation = rollResult.nationCode;
      duel.drawnYear = rollResult.year;
      duel.candidates = (rollResult.squad || []).map((player) => ({
        ...player,
        draftedNation: rollResult.nationCode,
        draftedYear: rollResult.year,
      }));
      state.pendingPickPlayer = null;

      state.busyAction = true;
      const event = await sendEvent("roll_result", {
        nation: duel.drawnNation,
        year: duel.drawnYear,
        candidates: duel.candidates,
        rollsUsed: duel.rollsUsed,
      });
      if (event?.id) duel.lastEventId = event.id;

      renderDuelBoard();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      state.busyAction = false;
    }
  }

  function selectCandidate(player) {
    if (!state.activeDuel || !currentUserTurn(state.activeDuel)) return;
    if (state.pendingPickPlayer && state.pendingPickPlayer.id === player.id) {
      state.pendingPickPlayer = null;
    } else {
      state.pendingPickPlayer = player;
    }
    renderDuelBoard();
  }

  async function handlePickPlayer(slotIdx) {
    if (state.busyAction) return;
    const duel = state.activeDuel;
    const player = state.pendingPickPlayer;
    if (!duel || !player) return;

    const slot = duel.mySlots[slotIdx];
    if (!slot) return;
    if (slot.player) {
      showToast("That slot is already occupied.", "error");
      return;
    }
    if (!Game.canPlayerFillSlot(player, slot.pos)) {
      showToast(`${player.name} cannot play as ${slot.pos}`, "error");
      return;
    }

    slot.player = {
      ...player,
      draftedNation: duel.drawnNation,
      draftedYear: duel.drawnYear,
    };

    state.pendingPickPlayer = null;
    duel.drawnNation = null;
    duel.drawnYear = null;
    duel.candidates = [];
    duel.rollsUsed = 0;
    duel.turn = nextTurn(duel.turn);

    try {
      state.busyAction = true;
      const event = await sendEvent("pick_player", {
        slotIndex: slotIdx,
        player: slot.player,
      });
      if (event?.id) duel.lastEventId = event.id;
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      state.busyAction = false;
    }

    renderDuelBoard();
    checkDuelCompletion();
  }

  function showCustomModal({ tag, icon, title, subtitle, boxHtml, primaryBtnText, primaryBtnAction, dangerBtnText, dangerBtnAction, secondaryBtnText, secondaryBtnAction }) {
    const overlay = document.getElementById("customModalOverlay");
    if (!overlay) {
      if (primaryBtnText && primaryBtnAction) primaryBtnAction();
      return;
    }

    const tagEl = document.getElementById("customModalTag");
    const iconEl = document.getElementById("customModalIcon");
    const titleEl = document.getElementById("customModalTitle");
    const subEl = document.getElementById("customModalSubtitle");
    const boxEl = document.getElementById("customModalBox");
    const footerEl = document.getElementById("customModalFooter");
    const closeBtn = document.getElementById("customModalClose");

    if (tagEl) tagEl.textContent = tag || "⚽ FOOTMON DUELS";
    if (iconEl) iconEl.textContent = icon || "🏆";
    if (titleEl) titleEl.textContent = title || "";
    if (subEl) subEl.textContent = subtitle || "";
    if (boxEl) {
      if (boxHtml) {
        boxEl.style.display = "flex";
        boxEl.innerHTML = boxHtml;
      } else {
        boxEl.style.display = "none";
      }
    }

    if (footerEl) footerEl.innerHTML = "";

    function closeModal() {
      overlay.classList.remove("open");
    }

    if (closeBtn) closeBtn.onclick = closeModal;

    if (secondaryBtnText && footerEl) {
      const btn = document.createElement("button");
      btn.className = "btn-modal-secondary";
      btn.textContent = secondaryBtnText;
      btn.onclick = () => {
        closeModal();
        if (secondaryBtnAction) secondaryBtnAction();
      };
      footerEl.appendChild(btn);
    }

    if (dangerBtnText && footerEl) {
      const btn = document.createElement("button");
      btn.className = "btn-modal-danger";
      btn.textContent = dangerBtnText;
      btn.onclick = () => {
        closeModal();
        if (dangerBtnAction) dangerBtnAction();
      };
      footerEl.appendChild(btn);
    }

    if (primaryBtnText && footerEl) {
      const btn = document.createElement("button");
      btn.className = "btn-modal-primary";
      btn.textContent = primaryBtnText;
      btn.onclick = () => {
        closeModal();
        if (primaryBtnAction) primaryBtnAction();
      };
      footerEl.appendChild(btn);
    }

    overlay.classList.add("open");
  }

  async function quitActiveDuel() {
    if (!state.activeDuel) return;

    showCustomModal({
      tag: "⚠️ FORFEIT WARNING",
      icon: "🚪",
      title: "Quit 1v1 Duel?",
      subtitle: "If you quit now, you will forfeit your staked MON to your opponent.",
      secondaryBtnText: "Keep Playing",
      dangerBtnText: "Quit & Forfeit",
      dangerBtnAction: async () => {
        try {
          const event = await sendEvent("duel_quit", {});
          if (event?.id) state.activeDuel.lastEventId = event.id;
          if (state.activeDuel.status === "waiting") {
            await apiFetch(`/api/duels/challenges/${encodeURIComponent(state.activeDuel.id)}`, {
              method: "PATCH",
              body: JSON.stringify({ status: "cancelled" }),
            });
          }
        } catch (err) {
          console.error("[Duel] Failed to notify quit", err);
        }

        state.pendingPickPlayer = null;
        state.activeDuel = null;
        stopEventPolling();
        switchMode("duel");
      }
    });
  }

  async function checkDuelCompletion() {
    const duel = state.activeDuel;
    if (!duel) return;

    const myFinished = duel.mySlots.every((slot) => slot.player);
    const opFinished = duel.opSlots.every((slot) => slot.player);
    if (!myFinished || !opFinished) return;

    duel.status = "completed";
    try {
      await apiFetch(`/api/duels/challenges/${encodeURIComponent(duel.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "completed" }),
      });
    } catch (e) {
      console.error("[Duel] Failed to mark completed on backend", e);
    }
    resolveDuelOutcome();
  }

  function resolveDuelOutcome() {
    const duel = state.activeDuel;
    if (!duel) return;

    const myScore = calculateSquadScore(duel.mySlots);
    const opScore = calculateSquadScore(duel.opSlots);
    const totalPot = (duel.stake * 2).toFixed(3);
    const winnerShare = (duel.stake * 2 * 0.7).toFixed(3);
    const houseCut = (duel.stake * 2 * 0.3).toFixed(3);

    if (myScore > opScore) {
      showCustomModal({
        tag: "🏆 DUEL VICTORY",
        icon: "🎉",
        title: "Victory!",
        subtitle: `Your squad defeated your opponent ${myScore} vs ${opScore}.`,
        boxHtml: `
          <div class="modal-stat-row"><span>Your Squad Score</span><span class="modal-stat-val gold">${myScore}</span></div>
          <div class="modal-stat-row"><span>Opponent Squad Score</span><span class="modal-stat-val">${opScore}</span></div>
          <div class="modal-stat-row" style="border-top: 1px solid var(--border2); padding-top: 8px;"><span>Total Pot Staked</span><span class="modal-stat-val">${totalPot} MON</span></div>
          <div class="modal-stat-row"><span>Winner Winnings (70%)</span><span class="modal-stat-val green">${winnerShare} MON</span></div>
          <div class="modal-stat-row"><span>House Platform Fee (30%)</span><span class="modal-stat-val purple">${houseCut} MON</span></div>
        `,
        primaryBtnText: `Claim ${winnerShare} MON Winnings 🎉`,
        primaryBtnAction: async () => {
          try {
            showToast(`Claiming ${winnerShare} MON payout to your wallet…`, "info");
            const signer = WalletManager.getSigner();
            const target = state.myAddress || CONTRACT_ADDRESS;
            const tx = await signer.sendTransaction({
              to: target,
              value: ethers.parseEther(winnerShare.toString()),
            });
            await tx.wait();
            showToast(`Claimed ${winnerShare} MON prize! 🎉`, "success");
          } catch (err) {
            showToast(err.message || "Claim transaction cancelled", "error");
          }
          state.activeDuel = null;
          switchMode("duel");
        }
      });
    } else if (myScore < opScore) {
      showCustomModal({
        tag: "💔 DUEL DEFEAT",
        icon: "💀",
        title: "Defeat",
        subtitle: `Your opponent won the duel ${opScore} vs ${myScore}.`,
        boxHtml: `
          <div class="modal-stat-row"><span>Your Squad Score</span><span class="modal-stat-val">${myScore}</span></div>
          <div class="modal-stat-row"><span>Opponent Squad Score</span><span class="modal-stat-val gold">${opScore}</span></div>
          <div class="modal-stat-row" style="border-top: 1px solid var(--border2); padding-top: 8px;"><span>Total Pot Staked</span><span class="modal-stat-val">${totalPot} MON</span></div>
          <div class="modal-stat-row"><span>Winner Payout (70%)</span><span class="modal-stat-val green">${winnerShare} MON</span></div>
          <div class="modal-stat-row"><span>House Platform Fee (30%)</span><span class="modal-stat-val purple">${houseCut} MON</span></div>
        `,
        primaryBtnText: "Back to Duel Lobby",
        primaryBtnAction: () => {
          state.activeDuel = null;
          switchMode("duel");
        }
      });
    } else {
      const refundShare = (duel.stake * 0.7).toFixed(3);
      showCustomModal({
        tag: "🤝 DUEL DRAW",
        icon: "⚖️",
        title: "Draw!",
        subtitle: `Both squads finished level at ${myScore}.`,
        boxHtml: `
          <div class="modal-stat-row"><span>Squad Rating</span><span class="modal-stat-val gold">${myScore}</span></div>
          <div class="modal-stat-row"><span>Total Pot Staked</span><span class="modal-stat-val">${totalPot} MON</span></div>
          <div class="modal-stat-row" style="border-top: 1px solid var(--border2); padding-top: 8px;"><span>Your Refund Share (70%)</span><span class="modal-stat-val green">${refundShare} MON</span></div>
          <div class="modal-stat-row"><span>House Fee (30%)</span><span class="modal-stat-val purple">${houseCut} MON</span></div>
        `,
        primaryBtnText: `Claim ${refundShare} MON Refund`,
        primaryBtnAction: async () => {
          try {
            showToast(`Claiming ${refundShare} MON refund…`, "info");
            const signer = WalletManager.getSigner();
            const target = state.myAddress || CONTRACT_ADDRESS;
            const tx = await signer.sendTransaction({
              to: target,
              value: ethers.parseEther(refundShare.toString()),
            });
            await tx.wait();
            showToast(`Claimed ${refundShare} MON refund! 🤝`, "success");
          } catch (err) {
            showToast(err.message || "Claim transaction cancelled", "error");
          }
          state.activeDuel = null;
          switchMode("duel");
        }
      });
    }
  }

  function calculateSquadScore(slots) {
    const filled = slots.filter((slot) => slot.player);
    if (!filled.length) return 0;
    const total = filled.reduce((sum, slot) => sum + slot.player.rating, 0);
    return parseFloat((total / filled.length).toFixed(2));
  }

  function getSquadStats(slots) {
    const filled = slots.filter((slot) => slot.player).map((slot) => slot.player);
    if (!filled.length) return { avg: "0.0", atk: 0, def: 0 };

    const total = filled.reduce((sum, player) => sum + player.rating, 0);
    let atk = 0;
    let def = 0;
    filled.forEach((player) => {
      atk += player.attack ?? player.stats?.att ?? Math.round(player.rating * 0.6);
      def += player.defense ?? player.stats?.def ?? Math.round(player.rating * 0.4);
    });

    return {
      avg: (total / filled.length).toFixed(1),
      atk: Math.round(atk / filled.length),
      def: Math.round(def / filled.length),
    };
  }

  function renderDuelBoard() {
    const duel = state.activeDuel;
    if (!duel) return;

    const isMyTurn = currentUserTurn(duel);
    const myStats = getSquadStats(duel.mySlots);
    const opStats = getSquadStats(duel.opSlots);

    if (Refs.turnBanner && Refs.turnText) {
      if (duel.status === "waiting") {
        Refs.turnBanner.classList.remove("my-turn");
        Refs.turnText.textContent = "WAITING FOR OPPONENT";
      } else if (isMyTurn) {
        Refs.turnBanner.classList.add("my-turn");
        Refs.turnText.textContent = "YOUR DRAFT TURN";
      } else {
        Refs.turnBanner.classList.remove("my-turn");
        Refs.turnText.textContent = "OPPONENT DRAFTING...";
      }
    }

    if (Refs.myAvg) Refs.myAvg.textContent = myStats.avg;
    if (Refs.myAttack) Refs.myAttack.textContent = myStats.atk;
    if (Refs.myDefense) Refs.myDefense.textContent = myStats.def;
    if (Refs.myAttackBar) Refs.myAttackBar.style.width = `${myStats.avg}%`;

    if (Refs.opAvg) Refs.opAvg.textContent = opStats.avg;
    if (Refs.opAttack) Refs.opAttack.textContent = opStats.atk;
    if (Refs.opDefense) Refs.opDefense.textContent = opStats.def;
    if (Refs.opAttackBar) Refs.opAttackBar.style.width = `${opStats.avg}%`;

    if (Refs.myAvg && Refs.opAvg) {
      if (parseFloat(myStats.avg) > parseFloat(opStats.avg)) {
        Refs.myAvg.style.color = "#f0c040";
        Refs.opAvg.style.color = "";
      } else if (parseFloat(myStats.avg) < parseFloat(opStats.avg)) {
        Refs.opAvg.style.color = "#f0c040";
        Refs.myAvg.style.color = "";
      } else {
        Refs.myAvg.style.color = "";
        Refs.opAvg.style.color = "";
      }
    }

    const remaining = Math.max(0, duel.freeRolls - duel.rollsUsed);
    if (Refs.rollsLeft) {
      Refs.rollsLeft.textContent = remaining > 0
        ? `${remaining} FREE ROLL${remaining !== 1 ? "S" : ""} LEFT`
        : "FREE ROLLS USED";
    }
    if (Refs.costBadge) {
      Refs.costBadge.style.display = duel.rollsUsed >= duel.freeRolls ? "inline-flex" : "none";
    }

    if (duel.status === "waiting") {
      renderWaitingState();
    } else if (duel.drawnNation === null) {
      renderRollPromptState(isMyTurn, remaining);
    } else {
      renderActiveDraftState(isMyTurn);
    }

    PitchRenderer.render(
      document.getElementById("pitchDuelPlayer"),
      duel.mySlots,
      isMyTurn ? state.pendingPickPlayer : null,
      null,
      (slotIdx) => {
        if (isMyTurn && state.pendingPickPlayer) {
          handlePickPlayer(slotIdx);
        }
      }
    );

    PitchRenderer.render(
      document.getElementById("pitchDuelOpponent"),
      duel.opSlots,
      null,
      null,
      () => {}
    );
  }

  function renderWaitingState() {
    if (Refs.draftEmptyState) {
      Refs.draftEmptyState.style.display = "flex";
      const titleEl = Refs.draftEmptyState.querySelector(".draft-empty-title");
      const descEl = Refs.draftEmptyState.querySelector(".draft-empty-desc");
      if (titleEl) titleEl.textContent = "Waiting for Opponent";
      if (descEl) descEl.textContent = "This challenge is now public. Another device can join from the duel lobby.";
    }
    if (Refs.draftActiveState) Refs.draftActiveState.style.display = "none";
    if (Refs.btnRoll) Refs.btnRoll.disabled = true;
  }

  function renderRollPromptState(isMyTurn, remaining) {
    if (Refs.draftEmptyState) {
      Refs.draftEmptyState.style.display = "flex";
      const titleEl = Refs.draftEmptyState.querySelector(".draft-empty-title");
      const descEl = Refs.draftEmptyState.querySelector(".draft-empty-desc");
      if (titleEl) titleEl.textContent = isMyTurn ? "Draft Next Player" : "Opponent's Turn";

      if (!isMyTurn) {
        if (descEl) descEl.textContent = "Your opponent is rolling for their next player.";
      } else if (remaining <= 0) {
        if (descEl) descEl.innerHTML = `Free rolls used.<br/>Paid rerolls preview at <strong>${ROLL_PRICE_MON} MON</strong>.`;
      } else {
        if (descEl) descEl.textContent = `Roll to draw a nation and year. ${remaining} free roll${remaining !== 1 ? "s" : ""} left.`;
      }
    }

    if (Refs.draftActiveState) Refs.draftActiveState.style.display = "none";
    if (Refs.btnRoll) {
      Refs.btnRoll.disabled = !isMyTurn;
      Refs.btnRoll.textContent = remaining <= 0 ? `Pay & Roll 🎲 (${ROLL_PRICE_MON} MON)` : "Roll 🎲";
    }
  }

  function renderActiveDraftState(isMyTurn) {
    const duel = state.activeDuel;
    if (!duel) return;

    if (Refs.draftEmptyState) Refs.draftEmptyState.style.display = "none";
    if (Refs.draftActiveState) Refs.draftActiveState.style.display = "flex";

    const iso2 = (ISO3_TO_2[duel.drawnNation] || duel.drawnNation.slice(0, 2)).toLowerCase();
    if (Refs.drawnFlag) {
      Refs.drawnFlag.innerHTML = `<img src="/flags/${iso2}.png" alt="${duel.drawnNation}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" />`;
    }
    if (Refs.drawnNation) Refs.drawnNation.textContent = duel.drawnNation;
    if (Refs.drawnYear) Refs.drawnYear.textContent = duel.drawnYear;

    if (!Refs.playerList) return;
    if (!isMyTurn) {
      Refs.playerList.innerHTML = `<div class="challenges-empty">Opponent is choosing a player...</div>`;
      return;
    }

    const assignedIds = new Set(
      duel.mySlots.filter((slot) => slot.player).map((slot) => slot.player.id)
    );

    Refs.playerList.innerHTML = duel.candidates.map((player) => {
      const alreadyUsed = assignedIds.has(player.id);
      const canFitAnywhere = duel.mySlots.some((slot) => !slot.player && Game.canPlayerFillSlot(player, slot.pos));
      const isSelected = state.pendingPickPlayer && state.pendingPickPlayer.id === player.id;

      let rowClass = "player-row";
      if (alreadyUsed) rowClass += " player-row--assigned";
      else if (!canFitAnywhere) rowClass += " player-row--disabled";
      else if (isSelected) rowClass += " player-row--selected";

      const isElite = !!player.isLegendary;
      const positions = Array.isArray(player.positions) ? player.positions.join(" / ") : (player.position || "");
      const barColor = isElite ? "#f0c040" : "var(--text3)";

      return `
        <div class="${rowClass}" data-pid="${player.id}">
          <div class="player-row-left">
            <span class="player-name ${isElite ? "player-name--elite" : ""}">${player.name}</span>
            <span class="player-pos-tags">${positions}</span>
          </div>
          <div class="player-rating-wrap">
            <div class="player-rating-bar"><div class="player-rating-bar-fill" style="width:${player.rating}%; background:${barColor};"></div></div>
            <span class="player-rating">${player.rating}</span>
          </div>
        </div>
      `;
    }).join("") || `<div class="challenges-empty">No eligible players for this roll.</div>`;

    Refs.playerList.querySelectorAll(".player-row").forEach((row) => {
      if (row.classList.contains("player-row--assigned") || row.classList.contains("player-row--disabled")) return;
      row.addEventListener("click", () => {
        const player = duel.candidates.find((item) => item.id === row.dataset.pid);
        if (player) selectCandidate(player);
      });
    });
  }

  function shortAddr(address) {
    if (!address || address.length < 10) return address || "Unknown";
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
  }

  function hasActiveDuel() {
    return !!state.activeDuel;
  }

  return { init, switchMode, hasActiveDuel };
})();

function bootstrapDuel() {
  if (window.__FOOTMON_DUEL_BOOTSTRAPPED__) return;
  window.__FOOTMON_DUEL_BOOTSTRAPPED__ = true;
  setTimeout(DuelManager.init, 100);
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", bootstrapDuel);
} else {
  bootstrapDuel();
}
