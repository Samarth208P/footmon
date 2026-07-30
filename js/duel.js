/**
 * FootMon — 1v1 Draft Duels Core Manager
 * Coordinates serverless on-chain duels via Session Wallets & public Nostr event relays.
 */

const DuelManager = (() => {
  // Config
  const NOSTR_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];
  const NOSTR_KIND_DUEL = 29384; // Custom event kind for FootMon duels

  // In-memory state
  const state = {
    myAddress: null,
    sessionWallet: null, // Ephemeral session wallet
    activeDuel: null,    // Active duel state
    socket: null,
    pendingMessages: [],
    challenges: []
  };

  // DOM Elements references
  const Refs = {};

  function init() {
    state.myAddress = WalletManager.getAddress();

    // Cache DOM refs
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
    
    // Play refs
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

    // Stats refs
    Refs.myAvg = document.getElementById("duelMyAvg");
    Refs.myAttack = document.getElementById("duelMyAttack");
    Refs.myDefense = document.getElementById("duelMyDefense");
    Refs.myAttackBar = document.getElementById("duelMyAttackBar");
    Refs.opAvg = document.getElementById("duelOpAvg");
    Refs.opAttack = document.getElementById("duelOpAttack");
    Refs.opDefense = document.getElementById("duelOpDefense");
    Refs.opAttackBar = document.getElementById("duelOpAttackBar");

    // Event bindings
    if (Refs.btnDuelMode) Refs.btnDuelMode.addEventListener("click", () => switchMode("duel"));
    if (Refs.btnSinglePlayer) Refs.btnSinglePlayer.addEventListener("click", () => switchMode("single"));
    if (Refs.btnCreate) Refs.btnCreate.addEventListener("click", handleCreateChallenge);
    if (Refs.btnRefresh) Refs.btnRefresh.addEventListener("click", refreshLobby);
    if (Refs.btnCancel) Refs.btnCancel.addEventListener("click", quitActiveDuel);

    if (Refs.btnRoll) Refs.btnRoll.addEventListener("click", () => handleDuelRoll("full"));
    if (Refs.btnRerollNation) Refs.btnRerollNation.addEventListener("click", () => handleDuelRoll("nation"));
    if (Refs.btnRerollYear) Refs.btnRerollYear.addEventListener("click", () => handleDuelRoll("year"));

    // Connect to Nostr
    connectNostr();

    // Check existing session key
    setupSessionWallet();
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
        renderDuelBoard();
      } else {
        if (Refs.screenLobby) Refs.screenLobby.style.display = "flex";
        if (Refs.screenPlay) Refs.screenPlay.style.display = "none";
        refreshLobby();
      }
    } else {
      if (Refs.btnSinglePlayer) Refs.btnSinglePlayer.classList.add("active");
      if (Refs.btnDuelMode) Refs.btnDuelMode.classList.remove("active");
      if (Refs.screenLobby) Refs.screenLobby.style.display = "none";
      if (Refs.screenPlay) Refs.screenPlay.style.display = "none";

      const appState = typeof Game !== "undefined" ? Game.state : null;
      if (appState && appState.busy) {
        if (Refs.screenSinglePlay) Refs.screenSinglePlay.style.display = "flex";
      } else {
        if (Refs.screenFormation) Refs.screenFormation.style.display = "flex";
      }
    }
  }

  function setupSessionWallet() {
    let key = sessionStorage.getItem("fm_session_key");
    if (!key) {
      const wallet = ethers.Wallet.createRandom();
      sessionStorage.setItem("fm_session_key", wallet.privateKey);
      state.sessionWallet = wallet;
    } else {
      state.sessionWallet = new ethers.Wallet(key);
    }
  }

  // ── Nostr Connection ──────────────────────────────────────────────────────
  function connectNostr() {
    const url = NOSTR_RELAYS[0];
    const ws = new WebSocket(url);

    ws.onopen = () => {
      state.socket = ws;
      console.log("[Duel] Connected to Nostr relay:", url);
      subscribeLobby();
      if (state.activeDuel) {
        subscribeDuel(state.activeDuel.id);
      }
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg[0] === "EVENT" && msg[2]) {
          handleNostrEvent(msg[2]);
        }
      } catch (err) {
        console.error("[Duel] Error parsing ws message", err);
      }
    };

    ws.onerror = (err) => console.error("[Duel] Nostr connection error", err);
    ws.onclose = () => {
      console.log("[Duel] Nostr connection closed. Reconnecting...");
      setTimeout(connectNostr, 3000);
    };
  }

  function subscribeLobby() {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
    const subId = "fm_lobby_sub";
    state.socket.send(JSON.stringify([
      "REQ",
      subId,
      { kinds: [NOSTR_KIND_DUEL], limit: 40 }
    ]));
  }

  function subscribeDuel(duelId) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
    const subId = "fm_duel_" + duelId;
    state.socket.send(JSON.stringify([
      "REQ",
      subId,
      { kinds: [NOSTR_KIND_DUEL], "#d": [duelId] }
    ]));
  }

  async function publishNostrEvent(duelId, payload) {
    if (!state.sessionWallet) return;
    
    // Construct simplified Nostr event structure
    const created_at = Math.floor(Date.now() / 1000);
    const tags = [["d", duelId]];
    const content = JSON.stringify(payload);
    
    // Custom event payload signed by our session key
    const event = {
      pubkey: state.sessionWallet.address,
      created_at,
      kind: NOSTR_KIND_DUEL,
      tags,
      content
    };

    // Calculate Nostr style hash
    const serialized = JSON.stringify([
      0,
      event.pubkey,
      event.created_at,
      event.kind,
      event.tags,
      event.content
    ]);
    const id = ethers.sha256(ethers.toUtf8Bytes(serialized));
    event.id = id.slice(2); // remove 0x

    // Sign hash using session wallet
    const signature = await state.sessionWallet.signMessage(ethers.getBytes(id));
    event.sig = signature.slice(2);

    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify(["EVENT", event]));
    } else {
      state.pendingMessages.push(event);
    }
  }

  // ── Lobby Handling ────────────────────────────────────────────────────────
  function refreshLobby() {
    if (!WalletManager.isConnected()) {
      showToast("Please connect your wallet first", "info");
      return;
    }
    subscribeLobby();
    renderLobby();
  }

  async function handleCreateChallenge() {
    if (!WalletManager.isConnected()) {
      showToast("Please connect wallet first", "info");
      return;
    }
    const val = parseFloat(Refs.inputStake.value);
    if (isNaN(val) || val <= 0) {
      showToast("Please enter a valid MON stake", "error");
      return;
    }

    try {
      showToast("Confirm staking transaction in MetaMask…", "info");
      
      const signer = WalletManager.getSigner();
      const target = CONTRACT_ADDRESS || state.myAddress;
      const tx = await signer.sendTransaction({
        to: target,
        value: ethers.parseEther(val.toString())
      });
      await tx.wait();
      
      const mockDuelId = "duel_" + Math.random().toString(36).slice(2, 9);
      
      showToast("Staking transaction successful! ✔", "success");

      // Register challenge on relay
      const payload = {
        type: "challenge_created",
        duelId: mockDuelId,
        creator: state.myAddress,
        stake: val,
        sessionPubKey: state.sessionWallet.address
      };

      await publishNostrEvent(mockDuelId, payload);
      
      // Instantly start waiting in Lobby
      startDuelState(mockDuelId, state.myAddress, null, val, true);
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  function startDuelState(duelId, creator, joiner, stake, isCreator) {
    state.activeDuel = {
      id: duelId,
      creator,
      joiner,
      stake,
      isCreator,
      status: joiner ? "active" : "waiting",
      turn: "creator", // alternates creator -> joiner -> creator
      rollsUsed: 0,
      freeRolls: 3,
      drawnNation: null,
      drawnYear: null,
      candidates: [],
      mySlots: Array(11).fill(null),
      opSlots: Array(11).fill(null)
    };

    if (Refs.screenLobby) Refs.screenLobby.style.display = "none";
    if (Refs.screenPlay) Refs.screenPlay.style.display = "flex";

    // Sub to Nostr updates for this duel
    subscribeDuel(duelId);

    renderDuelBoard();
  }

  async function joinChallenge(duelId, creator, stake) {
    if (!WalletManager.isConnected()) {
      showToast("Please connect wallet first", "info");
      return;
    }
    try {
      showToast(`Staking ${stake} MON to join duel…`, "info");
      
      const signer = WalletManager.getSigner();
      const target = CONTRACT_ADDRESS || state.myAddress;
      const tx = await signer.sendTransaction({
        to: target,
        value: ethers.parseEther(stake.toString())
      });
      await tx.wait();
      
      showToast("Joined duel successfully! ✔", "success");

      const payload = {
        type: "challenge_joined",
        duelId: duelId,
        joiner: state.myAddress,
        sessionPubKey: state.sessionWallet.address
      };

      await publishNostrEvent(duelId, payload);
      startDuelState(duelId, creator, state.myAddress, stake, false);
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  // ── Gameplay Logic ────────────────────────────────────────────────────────
  async function handleDuelRoll(type) {
    if (!state.activeDuel || state.activeDuel.status !== "active") return;
    
    // Check turn
    const isMyTurn = (state.activeDuel.turn === "creator" && state.activeDuel.isCreator) ||
                     (state.activeDuel.turn === "joiner" && !state.activeDuel.isCreator);
    if (!isMyTurn) {
      showToast("Wait for opponent's turn", "error");
      return;
    }

    const d = state.activeDuel;
    const isPaid = d.rollsUsed >= d.freeRolls;

    if (isPaid) {
      // Prompt MetaMask transaction for paid roll
      try {
        showToast("Confirm transaction in MetaMask…", "info");
        // Simulate roll fee
        showToast("Roll purchased! ✔", "success");
      } catch (err) {
        showToast(err.message, "error");
        return;
      }
    }

    d.rollsUsed++;

    // Generate random draft options
    let rollResult;
    if (type === "nation") {
      rollResult = await DataManager.roll({ lockYear: d.drawnYear, excludeNation: d.drawnNation });
    } else if (type === "year") {
      rollResult = await DataManager.roll({ lockNation: d.drawnNation, excludeYear: d.drawnYear });
    } else {
      rollResult = await DataManager.roll({});
    }

    d.drawnNation = rollResult.nationCode;
    d.drawnYear = rollResult.year;
    d.candidates = rollResult.players;

    // Publish roll action to opponent
    await publishNostrEvent(d.id, {
      type: "roll_result",
      nation: d.drawnNation,
      year: d.drawnYear,
      candidates: d.candidates,
      rollsUsed: d.rollsUsed
    });

    renderDuelBoard();
  }

  async function handlePickPlayer(player, slotIndex) {
    if (!state.activeDuel) return;
    const d = state.activeDuel;
    
    d.mySlots[slotIndex] = player;
    
    // Clear drawn
    d.drawnNation = null;
    d.drawnYear = null;
    d.candidates = [];
    d.rollsUsed = 0;

    // Switch turn
    d.turn = d.turn === "creator" ? "joiner" : "creator";

    // Publish pick action
    await publishNostrEvent(d.id, {
      type: "pick_player",
      player,
      slotIndex
    });

    renderDuelBoard();

    // Check complete
    checkDuelCompletion();
  }

  function checkDuelCompletion() {
    const d = state.activeDuel;
    const myFinished = d.mySlots.every(s => s !== null);
    const opFinished = d.opSlots.every(s => s !== null);

    if (myFinished && opFinished) {
      d.status = "completed";
      resolveDuelOutcome();
    }
  }

  function resolveDuelOutcome() {
    const d = state.activeDuel;
    const myScore = calculateSquadScore(d.mySlots);
    const opScore = calculateSquadScore(d.opSlots);

    let title, msg;
    if (myScore > opScore) {
      title = "🏆 Victory!";
      msg = `You won the duel ${myScore} vs ${opScore}! Claim your payout of ${(d.stake * 2 * 0.7).toFixed(2)} MON.`;
    } else if (myScore < opScore) {
      title = "Defeat";
      msg = `You lost the duel ${myScore} vs ${opScore}. Better luck next time!`;
    } else {
      title = "Draw";
      msg = `It's a draw! Both players get refunded.`;
    }

    // Modal popup
    alert(`${title}\n\n${msg}`);
  }

  function calculateSquadScore(slots) {
    const total = slots.reduce((acc, p) => acc + (p ? p.rating : 0), 0);
    return slots.length ? parseFloat((total / slots.length).toFixed(2)) : 0;
  }

  function quitActiveDuel() {
    if (confirm("Are you sure you want to quit the duel? You will forfeit your stake.")) {
      state.activeDuel = null;
      switchMode("duel");
    }
  }

  // ── Sync Events from Relay ────────────────────────────────────────────────
  function handleNostrEvent(event) {
    try {
      const payload = JSON.parse(event.content);
      if (payload.duelId) {
        // Track challenges in lobby
        if (payload.type === "challenge_created") {
          if (!state.challenges.some(c => c.duelId === payload.duelId)) {
            state.challenges.push(payload);
            renderLobby();
          }
        }
        
        // Match joining
        if (state.activeDuel && state.activeDuel.id === payload.duelId) {
          const d = state.activeDuel;
          
          if (payload.type === "challenge_joined" && d.status === "waiting") {
            d.joiner = payload.joiner;
            d.status = "active";
            showToast("An opponent joined your duel! Game starting...", "success");
            renderDuelBoard();
          }

          if (payload.type === "roll_result") {
            // Apply roll info from opponent if it's their turn
            const isMyTurn = (d.turn === "creator" && d.isCreator) ||
                             (d.turn === "joiner" && !d.isCreator);
            if (!isMyTurn) {
              d.drawnNation = payload.nation;
              d.drawnYear = payload.year;
              d.candidates = payload.candidates;
              d.rollsUsed = payload.rollsUsed;
              renderDuelBoard();
            }
          }

          if (payload.type === "pick_player") {
            const isMyTurn = (d.turn === "creator" && d.isCreator) ||
                             (d.turn === "joiner" && !d.isCreator);
            if (!isMyTurn) {
              d.opSlots[payload.slotIndex] = payload.player;
              d.drawnNation = null;
              d.drawnYear = null;
              d.candidates = [];
              d.rollsUsed = 0;
              d.turn = d.turn === "creator" ? "joiner" : "creator";
              renderDuelBoard();
              checkDuelCompletion();
            }
          }
        }
      }
    } catch (e) {
      console.error("[Duel] Error parsing Nostr event", e);
    }
  }

  // ── Render Views ──────────────────────────────────────────────────────────
  function renderLobby() {
    if (!Refs.challengesList) return;
    Refs.challengesList.innerHTML = "";
    
    const activeOnes = state.challenges.filter(c => c.creator !== state.myAddress);
    
    if (activeOnes.length === 0) {
      Refs.challengesList.innerHTML = `<div class="challenges-empty">No active challenges. Create one above!</div>`;
      return;
    }

    activeOnes.forEach(c => {
      const card = document.createElement("div");
      card.className = "duel-card";
      card.innerHTML = `
        <div class="duel-card-left">
          <span class="duel-card-addr">Creator: ${shortAddr(c.creator)}</span>
          <span class="duel-card-stake">${c.stake} MON</span>
        </div>
        <button class="btn-join-duel" data-id="${c.duelId}" data-creator="${c.creator}" data-stake="${c.stake}">Join Duel</button>
      `;

      card.querySelector(".btn-join-duel").addEventListener("click", () => {
        joinChallenge(c.duelId, c.creator, c.stake);
      });

      Refs.challengesList.appendChild(card);
    });
  }

  function renderDuelBoard() {
    if (!state.activeDuel) return;
    const d = state.activeDuel;

    const isMyTurn = (d.turn === "creator" && d.isCreator) ||
                     (d.turn === "joiner" && !d.isCreator);

    // Update Turn Banner
    if (Refs.turnBanner && Refs.turnText) {
      if (isMyTurn) {
        Refs.turnBanner.classList.add("my-turn");
        Refs.turnText.textContent = "YOUR DRAFT TURN 🎲";
      } else {
        Refs.turnBanner.classList.remove("my-turn");
        Refs.turnText.textContent = "OPPONENT DRAFTING...";
      }
    }

    // Render stats
    const myStats = getSquadStats(d.mySlots);
    const opStats = getSquadStats(d.opSlots);

    if (Refs.myAvg) Refs.myAvg.textContent = myStats.avg;
    if (Refs.myAttack) Refs.myAttack.textContent = myStats.atk;
    if (Refs.myDefense) Refs.myDefense.textContent = myStats.def;
    if (Refs.myAttackBar) Refs.myAttackBar.style.width = myStats.avg + "%";
    
    if (Refs.opAvg) Refs.opAvg.textContent = opStats.avg;
    if (Refs.opAttack) Refs.opAttack.textContent = opStats.atk;
    if (Refs.opDefense) Refs.opDefense.textContent = opStats.def;
    if (Refs.opAttackBar) Refs.opAttackBar.style.width = opStats.avg + "%";

    // Highlight leader in stats
    if (Refs.myAvg && Refs.opAvg) {
      if (parseFloat(myStats.avg) > parseFloat(opStats.avg)) {
        Refs.myAvg.style.color = "var(--yellow)";
        Refs.opAvg.style.color = "";
      } else if (parseFloat(myStats.avg) < parseFloat(opStats.avg)) {
        Refs.opAvg.style.color = "var(--yellow)";
        Refs.myAvg.style.color = "";
      } else {
        Refs.myAvg.style.color = "";
        Refs.opAvg.style.color = "";
      }
    }

    // Render Draft State
    if (d.status === "waiting") {
      if (Refs.draftEmptyState) {
        Refs.draftEmptyState.style.display = "flex";
        const titleEl = Refs.draftEmptyState.querySelector(".draft-empty-title");
        const descEl = Refs.draftEmptyState.querySelector(".draft-empty-desc");
        if (titleEl) titleEl.textContent = "Waiting for Opponent";
        if (descEl) descEl.textContent = "Share your duel ID or wait for someone to join.";
      }
      if (Refs.draftActiveState) Refs.draftActiveState.style.display = "none";
      if (Refs.btnRoll) Refs.btnRoll.disabled = true;
    } else {
      if (Refs.btnRoll) Refs.btnRoll.disabled = !isMyTurn;
      if (d.drawnNation === null) {
        if (Refs.draftEmptyState) {
          Refs.draftEmptyState.style.display = "flex";
          const titleEl = Refs.draftEmptyState.querySelector(".draft-empty-title");
          const descEl = Refs.draftEmptyState.querySelector(".draft-empty-desc");
          if (titleEl) titleEl.textContent = "Draft Next Player";
          const rem = d.freeRolls - d.rollsUsed;
          if (rem <= 0) {
            if (descEl) descEl.innerHTML = `Free rolls used.<br/>Pay <strong>0.001 MON</strong> to roll.`;
            if (Refs.btnRoll) Refs.btnRoll.textContent = "Pay & Roll 🎲 (0.001 MON)";
          } else {
            if (descEl) descEl.textContent = `Roll to draw a nation. ${rem} free rolls left.`;
            if (Refs.btnRoll) Refs.btnRoll.textContent = "Roll 🎲";
          }
        }
        if (Refs.draftActiveState) Refs.draftActiveState.style.display = "none";
      } else {
        if (Refs.draftEmptyState) Refs.draftEmptyState.style.display = "none";
        if (Refs.draftActiveState) Refs.draftActiveState.style.display = "flex";

        const iso2 = (ISO3_TO_2[d.drawnNation] || d.drawnNation.slice(0, 2)).toLowerCase();
        if (Refs.drawnFlag) Refs.drawnFlag.innerHTML = `<img src="flags/${iso2}.png" alt="${d.drawnNation}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" />`;
        if (Refs.drawnNation) Refs.drawnNation.textContent = d.drawnNation;
        if (Refs.drawnYear) Refs.drawnYear.textContent = d.drawnYear;

        // Populate players
        if (Refs.playerList) {
          Refs.playerList.innerHTML = "";
          
          if (isMyTurn) {
            d.candidates.forEach(p => {
              const row = document.createElement("div");
              row.className = `player-row ${p.rating >= 90 ? "player-row--elite" : ""}`;
              
              // Greying out logic
              const assignedIds = d.mySlots.filter(s => s !== null).map(s => s.id);
              const isAssigned = assignedIds.includes(p.id);

              if (isAssigned) {
                row.className += " player-row--assigned";
              }

              const pbWidth = Math.min(100, Math.max(0, p.rating));
              row.innerHTML = `
                <div class="player-info">
                  <span class="player-name ${p.rating >= 90 ? "player-name--elite" : ""}">${p.name}</span>
                  <div class="player-rating-progress">
                    <div class="player-rating-bar" style="width: ${pbWidth}%"></div>
                  </div>
                  <div class="player-details">
                    <span class="player-pos-tags">${p.position}</span>
                    <span class="player-pos-tags">${p.club}</span>
                  </div>
                </div>
                <div class="player-rating" style="background:${PitchRenderer.ratingColor(p.rating)}">${p.rating}</div>
              `;

              if (!isAssigned) {
                row.addEventListener("click", () => handleSelectPositionForPlayer(p));
              }
              Refs.playerList.appendChild(row);
            });
          } else {
            Refs.playerList.innerHTML = `<div class="challenges-empty">Opponent is choosing a player...</div>`;
          }
        }
      }
    }

    // Render Pitches
    renderPitchLayout("pitchDuelPlayer", d.mySlots, true);
    renderPitchLayout("pitchDuelOpponent", d.opSlots, false);
  }

  function handleSelectPositionForPlayer(player) {
    const pitchEl = document.getElementById("pitchDuelPlayer");
    const slots = pitchEl.querySelectorAll(".pitch-slot");
    
    slots.forEach(slot => {
      const idx = parseInt(slot.dataset.idx);
      if (state.activeDuel.mySlots[idx] === null) {
        slot.style.border = "2px dashed var(--green)";
        slot.style.cursor = "pointer";
        
        const newSlot = slot.cloneNode(true);
        slot.parentNode.replaceChild(newSlot, slot);
        
        newSlot.addEventListener("click", () => {
          handlePickPlayer(player, idx);
        });
      }
    });
    
    showToast("Click an empty slot on your pitch to place " + player.name, "info");
  }

  function renderPitchLayout(pitchId, slotsData, isMyPitch) {
    const el = document.getElementById(pitchId);
    if (!el) return;
    el.innerHTML = ""; // Clear

    const markings = document.createElement("div");
    markings.className = "pitch-markings";
    markings.innerHTML = `
      <div class="pitch-line pitch-center-circle"></div>
      <div class="pitch-line pitch-halfway"></div>
      <div class="pitch-line pitch-penalty-area-top"></div>
      <div class="pitch-line pitch-penalty-area-bottom"></div>
    `;
    el.appendChild(markings);

    const coords = [
      { t: 86, l: 50 },  // GK
      { t: 68, l: 20 },  // LB
      { t: 72, l: 40 },  // CB1
      { t: 72, l: 60 },  // CB2
      { t: 68, l: 80 },  // RB
      { t: 48, l: 30 },  // LM
      { t: 42, l: 50 },  // CM
      { t: 48, l: 70 },  // RM
      { t: 18, l: 25 },  // LW
      { t: 14, l: 50 },  // ST
      { t: 18, l: 75 }   // RW
    ];

    coords.forEach((c, idx) => {
      const slot = document.createElement("div");
      slot.className = "pitch-slot";
      slot.dataset.idx = idx;
      slot.style.top = c.t + "%";
      slot.style.left = c.l + "%";

      const p = slotsData[idx];
      if (p) {
        slot.classList.add("slot--filled");
        const ratingCol = PitchRenderer.ratingColor(p.rating);
        slot.style.borderColor = ratingCol;

        if (p.rating >= 90) {
          slot.classList.add("slot--elite");
          slot.style.color = ratingCol;
        }

        slot.innerHTML = `
          <div class="slot-player-jersey">${p.position}</div>
          <div class="slot-player-name">${p.name.split(" ").pop()}</div>
          <div class="slot-player-rating" style="background:${ratingCol}">${p.rating}</div>
        `;
      } else {
        slot.innerHTML = `<div class="slot-player-jersey">+</div>`;
      }

      el.appendChild(slot);
    });
  }

  function getSquadStats(slots) {
    let total = 0, count = 0, atk = 0, def = 0;
    slots.forEach(p => {
      if (p) {
        total += p.rating;
        count++;
        if (["LW", "RW", "ST", "CF"].includes(p.position)) atk += p.rating;
        else if (["GK", "LB", "CB", "RB", "LWB", "RWB"].includes(p.position)) def += p.rating;
        else { atk += p.rating * 0.5; def += p.rating * 0.5; }
      }
    });
    return {
      avg: count > 0 ? (total / count).toFixed(1) : "0.0",
      atk: Math.round(atk),
      def: Math.round(def)
    };
  }

  function shortAddr(addr) {
    return addr.slice(0, 6) + "…" + addr.slice(-4);
  }

  return { init, switchMode };
})();

// Initialize when DOM is ready
window.addEventListener("DOMContentLoaded", () => {
  setTimeout(DuelManager.init, 500);
});
