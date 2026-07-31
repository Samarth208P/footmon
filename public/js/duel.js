/**
 * FootMon — 1v1 Draft Duels
 * Cross-device/public-internet transport via Next API routes backed by Supabase.
 */

const DuelManager = (() => {
  const DUEL_FORMATION = "4-3-3";
  const DUEL_STYLE = "balanced";
  const CHALLENGE_POLL_MS = 2000;
  // Realtime broadcast carries live traffic. This poll only exists to recover
  // events missed while disconnected, so it can be slow and cheap.
  const EVENT_POLL_MS = 5000;

  const state = {
    instanceId: `duel_${Math.random().toString(36).slice(2, 10)}`,
    myAddress: null,
    sessionWallet: null,
    activeDuel: null,
    pendingPickPlayer: null,
    challengePollTimer: null,
    eventPollTimer: null,
    roomStatusText: "",
    roomStatusTone: "info",
  };

  const Refs = {};

  // Last lobby payload, kept so the list can be redrawn when usernames arrive.
  let lastLobbyChallenges = null;

  function init() {
    cacheRefs();
    bindEvents();
    setupSessionWallet();
    refreshWalletState();
    renderRoomStatus();
    renderLobby([]);
    consumeInviteLink();
  }

  /**
   * Handles arrival via /duel/<CODE>#pw=<password>.
   *
   * The fields are pre-filled rather than auto-joining: joining escrows real MON,
   * so it must stay an explicit action the player takes.
   */
  function consumeInviteLink() {
    const invite = DuelRoom.parseInvite();
    if (!invite) return;

    switchMode("duel");

    if (Refs.inputJoinCode) Refs.inputJoinCode.value = invite.code;
    if (Refs.inputJoinPassword && invite.password) {
      Refs.inputJoinPassword.value = invite.password;
    }

    // Strip the password from the address bar so it is not left in history.
    if (invite.password && window.history?.replaceState) {
      window.history.replaceState(null, "", `/duel/${invite.code}`);
    }

    setLobbyStatus(
      `Invited to room ${invite.code}${invite.password ? " (password filled in)" : ""} — press Join Duel to stake and enter.`,
      "info"
    );
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
    Refs.lobbyStatus = document.getElementById("duelLobbyStatus");
    Refs.duelRoomStatus = document.getElementById("duelRoomStatus");
    Refs.inputPrivate = document.getElementById("inputDuelPrivate");
    Refs.inputPassword = document.getElementById("inputDuelPassword");
    Refs.waitingPanel = document.getElementById("duelWaitingPanel");
    Refs.waitingRoomCode = document.getElementById("waitingRoomCode");
    Refs.waitingPasswordField = document.getElementById("waitingPasswordField");
    Refs.waitingPassword = document.getElementById("waitingPassword");
    Refs.waitingLink = document.getElementById("waitingLink");
    Refs.waitingLinkNote = document.getElementById("waitingLinkNote");
    Refs.btnCancelRoom = document.getElementById("btnCancelRoom");
    Refs.inputJoinCode = document.getElementById("inputJoinCode");
    Refs.inputJoinPassword = document.getElementById("inputJoinPassword");
    Refs.btnJoinByCode = document.getElementById("btnJoinByCode");

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

    // Only show the password field when the room is actually private.
    if (Refs.inputPrivate) {
      Refs.inputPrivate.addEventListener("change", () => {
        if (Refs.inputPassword) {
          Refs.inputPassword.style.display = Refs.inputPrivate.checked ? "block" : "none";
          if (!Refs.inputPrivate.checked) Refs.inputPassword.value = "";
        }
      });
    }

    if (Refs.waitingPanel) {
      Refs.waitingPanel.querySelectorAll(".waiting-copy").forEach((button) => {
        button.addEventListener("click", () => copyInviteValue(button.dataset.copy, button));
      });
    }

    if (Refs.btnCancelRoom) {
      Refs.btnCancelRoom.addEventListener("click", async () => {
        if (!state.activeDuel) return;
        Refs.btnCancelRoom.disabled = true;
        Refs.btnCancelRoom.textContent = "Confirm in wallet…";
        try {
          await DuelRoom.cancel();
          DuelRoom.forgetPassword(state.activeDuel.roomCode);
          showToast("Room cancelled — your stake was refunded.", "success");
          clearActiveDuel();
          switchMode("duel");
        } catch (err) {
          showToast(friendlyError(err), "error");
        } finally {
          Refs.btnCancelRoom.disabled = false;
          Refs.btnCancelRoom.textContent = "Cancel & refund my stake";
        }
      });
    }

    if (Refs.btnJoinByCode) {
      Refs.btnJoinByCode.addEventListener("click", () => {
        const code = Refs.inputJoinCode?.value?.trim().toUpperCase();
        if (!code) {
          showToast("Enter a room code", "error");
          return;
        }
        const password = Refs.inputJoinPassword?.value?.trim() || null;
        Refs.btnJoinByCode.disabled = true;
        joinChallenge(code, password).finally(() => {
          Refs.btnJoinByCode.disabled = false;
        });
      });
    }

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

  // ── Live transport ────────────────────────────────────────────────────────
  // Supabase Realtime broadcast carries live turn/draft/match traffic; a slow
  // Postgres poll is kept purely as a reconnection safety net, since broadcast
  // messages are lost while a client is not subscribed.
  //
  // Replaced: a shared public piesocket demo relay with a hardcoded API key
  // (world-readable and forgeable) plus a localStorage "storage" listener that
  // only ever synced tabs inside one browser.

  function currentTransportStatus() {
    if (!RealtimeManager.isAvailable()) return "polling";
    return RealtimeManager.isLive() ? "live" : "connecting";
  }

  function setRoomStatus(text, tone) {
    state.roomStatusText = text || "";
    state.roomStatusTone = tone || "info";
    renderRoomStatus();
  }

  function renderRoomStatus() {
    const el = Refs.duelRoomStatus;
    if (!el) return;
    el.textContent = state.roomStatusText || "";
    el.dataset.tone = state.roomStatusTone || "info";
    el.style.display = state.roomStatusText ? "block" : "none";
  }

  /** Applies one raw event from either transport through the normaliser. */
  function ingestEvents(rawEvents, source) {
    const duel = state.activeDuel;
    if (!duel) return;

    const normalized = (Array.isArray(rawEvents) ? rawEvents : [rawEvents])
      .map((raw) => DuelEvents.normalizeEvent(raw, source))
      .filter(Boolean);

    if (normalized.length === 0) return;

    const { events, added } = DuelEvents.mergeEvents(duel.events || [], normalized);
    duel.events = events;
    duel.lastEventId = DuelEvents.maxEventId(events);

    for (const event of added) {
      applyDuelEvent(event);
    }
  }

  async function connectRoomTransport(duelId) {
    const live = await RealtimeManager.join(duelId, {
      selfId: state.instanceId,

      onEvent: (payload) => {
        if (!payload) return;
        ingestEvents(payload, "realtime");
      },

      onStatus: ({ status, detail }) => {
        if (status === "connected") {
          setRoomStatus("Connected", "ok");
        } else if (status === "connecting") {
          setRoomStatus("Connecting to opponent…", "info");
        } else if (status === "resync-required") {
          // Anything broadcast while we were away is unrecoverable, so take the
          // durable path immediately rather than waiting for the slow tick.
          catchUpFromDatabase().catch(() => {});
        } else if (status === "unavailable" || status === "polling") {
          setRoomStatus("Live sync unavailable — using slower updates", "warn");
        } else if (status === "error" || status === "timeout") {
          setRoomStatus("Connection problem — retrying", "warn");
          if (detail) console.warn("[Duel] realtime:", detail);
        } else if (status === "disconnected") {
          setRoomStatus("Reconnecting…", "warn");
        }
      },

      onPresence: ({ opponentPresent }) => {
        const duel = state.activeDuel;
        if (!duel) return;
        duel.opponentPresent = opponentPresent;
        if (!duel.joiner) {
          setRoomStatus("Waiting for an opponent to join…", "info");
        } else if (opponentPresent) {
          setRoomStatus("Opponent connected", "ok");
        } else {
          setRoomStatus("Opponent disconnected — waiting for them to return…", "warn");
        }
      },
    });

    if (!live) {
      setRoomStatus("Live sync unavailable — using slower updates", "warn");
    }
    return live;
  }

  /** Authoritative re-sync from Postgres. Used on reconnect and on a slow tick. */
  async function catchUpFromDatabase() {
    const duel = state.activeDuel;
    if (!duel) return;

    const { events } = await apiFetch(
      `/api/duels/events?duelId=${encodeURIComponent(duel.id)}&after=${duel.lastEventId || 0}`
    );
    ingestEvents(events || [], "poll");
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

  function setLobbyStatus(text, tone) {
    const el = Refs.lobbyStatus;
    if (!el) return;
    el.textContent = text || "";
    el.dataset.tone = tone || "info";
    el.style.display = text ? "block" : "none";
  }

  async function refreshLobby() {
    refreshWalletState();
    if (!WalletManager.isConnected()) {
      setLobbyStatus("Connect your wallet to browse and create duels.", "info");
      renderLobby([]);
      return;
    }

    try {
      // duel_lobby already excludes private rooms and rooms with an opponent.
      const { rooms } = await apiFetch("/api/duels/rooms");
      const open = rooms || [];

      if (!RealtimeManager.isAvailable()) {
        setLobbyStatus("Live sync unavailable — the lobby will update slowly.", "warn");
      } else if (open.length === 0) {
        setLobbyStatus("No open duels yet. Create one to get started.", "info");
      } else {
        setLobbyStatus(
          `${open.length} open duel${open.length === 1 ? "" : "s"} — pick one to join.`,
          "ok"
        );
      }

      renderLobby(open);
    } catch (err) {
      setLobbyStatus("Could not reach the lobby. Retrying…", "warn");
      showToast(err.message, "error");
    }

    let localList = JSON.parse(localStorage.getItem("fm_challenges") || "[]");
    const combined = [...apiChallenges];
    localList.forEach(lc => {
      if (!combined.some(c => c.duel_id === lc.duel_id)) {
        combined.push(lc);
      }
    });

    renderLobby(combined);
  }

  function renderLobby(challenges) {
    if (!Refs.challengesList) return;

    // Remember the last payload so we can redraw when usernames resolve.
    if (challenges) lastLobbyChallenges = challenges;

    if (!WalletManager.isConnected()) {
      Refs.challengesList.innerHTML = `<div class="challenges-empty">Connect your wallet to browse public duel challenges.</div>`;
      return;
    }

    const activeChallenges = (challenges || []).filter((challenge) => (
      challenge && challenge.creator && challenge.status === "open"
    ));

    if (!activeChallenges.length) {
      Refs.challengesList.innerHTML = `<div class="challenges-empty">No active challenges found. Create one above!</div>`;
      return;
    }

    // Resolve creator names, then re-render when they arrive.
    ProfileManager.prefetch(activeChallenges.map((c) => c.creator));

    Refs.challengesList.innerHTML = activeChallenges.map((room) => {
      // Stakes are wei on-chain; render as MON.
      const stakeMon = room.stake_mon ?? formatStake(room.stake);
      return `
      <div class="duel-card">
        <div class="duel-card-left">
          <span class="duel-card-addr">Creator: ${ProfileManager.usernameFor(room.creator)}</span>
          <span class="duel-card-stake">${stakeMon} MON</span>
        </div>
        <button class="btn-join-duel" data-code="${room.room_code}">
          Join Duel
        </button>
      </div>`;
    }).join("");

    Refs.challengesList.querySelectorAll(".btn-join-duel").forEach((button) => {
      button.addEventListener("click", () => {
        button.disabled = true;
        joinChallenge(button.dataset.code, null).finally(() => {
          button.disabled = false;
        });
      });
    });
  }

  /** wei (string) → MON, tolerating a value that is already in MON. */
  function formatStake(stake) {
    const raw = String(stake ?? "0");
    try {
      // Anything with a decimal point is already MON.
      if (raw.includes(".")) return Number(raw).toFixed(3).replace(/\.?0+$/, "");
      return Number(ethers.formatEther(raw)).toFixed(3).replace(/\.?0+$/, "");
    } catch {
      return raw;
    }
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

  /**
   * Creates a duel with the stake ESCROWED in the contract.
   *
   * Replaced: a raw `sendTransaction` to `CONTRACT_ADDRESS || state.myAddress`.
   * That either paid the stake into the hourly prize pool via the contract's
   * receive() fallback, or sent it to the player's own address — in neither case
   * was anything escrowed, so a duel could never actually pay out a winner.
   */
  async function handleCreateChallenge() {
    refreshWalletState();
    if (!WalletManager.isConnected()) {
      showToast("Please connect wallet first", "info");
      return;
    }
    if (!ProfileManager.getMyUsername()) {
      showToast("Pick a username before creating a duel", "info");
      return;
    }

    const stake = parseFloat(Refs.inputStake?.value);
    if (Number.isNaN(stake) || stake <= 0) {
      showToast("Please enter a valid MON stake", "error");
      return;
    }

    const isPrivate = Boolean(Refs.inputPrivate?.checked);
    const password = Refs.inputPassword?.value?.trim() || null;
    if (isPrivate && (!password || password.length < 4)) {
      showToast("A private room needs a password of at least 4 characters", "error");
      return;
    }

    setLobbyStatus("Confirm the stake in your wallet…", "info");
    if (Refs.btnCreate) Refs.btnCreate.disabled = true;

    try {
      const { room, shareLink } = await DuelRoom.createRoom({
        stakeMon: stake,
        isPrivate,
        password,
      });

      // One signature buys a session for every later pick in this room.
      await DuelRoom.openSession(room.room_code);

      startDuelState({
        id: room.id,
        roomCode: room.room_code,
        duelId: room.duel_id,
        creator: room.creator,
        joiner: room.joiner,
        stake,
        isCreator: true,
        status: room.joiner ? "active" : "waiting",
      });

      showRoomInvite();
      showToast("Stake escrowed. Share the room code to invite an opponent.", "success");
    } catch (err) {
      setLobbyStatus("", "info");
      showToast(friendlyError(err), "error");
    } finally {
      if (Refs.btnCreate) Refs.btnCreate.disabled = false;
    }
  }

  /** Joins a duel by room code, matching the stake on-chain. */
  async function joinChallenge(roomCode, password = null) {
    refreshWalletState();
    if (!WalletManager.isConnected()) {
      showToast("Please connect wallet first", "info");
      return;
    }
    if (!ProfileManager.getMyUsername()) {
      showToast("Pick a username before joining a duel", "info");
      return;
    }

    setLobbyStatus("Matching the stake in your wallet…", "info");

    try {
      const { room } = await DuelRoom.joinRoom(roomCode, password);
      await DuelRoom.openSession(room.room_code);

      startDuelState({
        id: room.id,
        roomCode: room.room_code,
        duelId: room.duel_id,
        creator: room.creator,
        joiner: room.joiner,
        stake: Number(ethers.formatEther(String(room.stake))),
        isCreator: false,
        status: "active",
      });

      showToast("Both stakes escrowed — ready up!", "success");
    } catch (err) {
      setLobbyStatus("", "info");
      showToast(friendlyError(err), "error");
    }
  }

  /** Turns wallet/contract errors into something a player can act on. */
  function friendlyError(err) {
    const message = err?.shortMessage || err?.message || "Something went wrong";

    if (err?.code === "ACTION_REJECTED" || /user rejected|denied/i.test(message)) {
      return "Transaction rejected — nothing was staked.";
    }
    if (/insufficient funds/i.test(message)) {
      return "Not enough MON to cover the stake plus gas.";
    }
    if (/stake mismatch/i.test(message)) {
      return "The stake changed — refresh the lobby and try again.";
    }
    if (/cannot self-join/i.test(message)) {
      return "You cannot join your own duel.";
    }
    if (/duel not open|already has an opponent/i.test(message)) {
      return "Someone else joined first. Try another duel.";
    }
    if (/Incorrect room password/i.test(message)) {
      return "Incorrect room password.";
    }
    return message;
  }

  /**
   * Shows the room code, password and invite link while waiting for an opponent.
   *
   * Lives on the duel screen, not the lobby: startDuelState() switches screens
   * immediately after creation, so the old lobby-side invite box was being
   * populated inside an already-hidden panel and was never visible.
   */
  function showRoomInvite() {
    const duel = state.activeDuel;
    const panel = Refs.waitingPanel;
    if (!panel || !duel) return;

    // Only while genuinely waiting for someone to join.
    if (duel.joiner) {
      hideRoomInvite();
      return;
    }

    const roomCode = duel.roomCode;
    const password = DuelRoom.passwordFor(roomCode);
    const link = DuelRoom.shareLinkFor(roomCode, password);

    panel.style.display = "block";

    if (Refs.waitingRoomCode) Refs.waitingRoomCode.textContent = roomCode || "--------";

    if (Refs.waitingPasswordField) {
      if (password) {
        Refs.waitingPasswordField.style.display = "block";
        if (Refs.waitingPassword) Refs.waitingPassword.textContent = password;
      } else {
        Refs.waitingPasswordField.style.display = "none";
      }
    }

    if (Refs.waitingLink) Refs.waitingLink.value = link;
    if (Refs.waitingLinkNote) {
      Refs.waitingLinkNote.textContent = password
        ? "This link already contains the password — send it only to your opponent."
        : "Anyone with this link, or browsing the lobby, can join.";
    }

    if (Refs.btnCancelRoom) {
      Refs.btnCancelRoom.style.display = duel.isCreator ? "block" : "none";
    }
  }

  function hideRoomInvite() {
    if (Refs.waitingPanel) Refs.waitingPanel.style.display = "none";
  }

  /** Copies one of the invite values, with a fallback when the clipboard is blocked. */
  async function copyInviteValue(kind, button) {
    const duel = state.activeDuel;
    if (!duel) return;

    const password = DuelRoom.passwordFor(duel.roomCode);
    const value =
      kind === "code"
        ? duel.roomCode
        : kind === "password"
          ? password
          : DuelRoom.shareLinkFor(duel.roomCode, password);

    if (!value) return;

    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = "Copied ✔";
      setTimeout(() => { button.textContent = original; }, 1600);
    } catch {
      if (kind === "link" && Refs.waitingLink) {
        Refs.waitingLink.select();
        showToast("Press Ctrl+C to copy the link", "info");
      } else {
        showToast(`${kind === "code" ? "Room code" : "Password"}: ${value}`, "info");
      }
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
      events: [],
      opponentPresent: false,
    };

    stopChallengePolling();
    if (Refs.screenLobby) Refs.screenLobby.style.display = "none";
    if (Refs.screenPlay) Refs.screenPlay.style.display = "flex";

    setRoomStatus(
      duel.joiner ? "Connecting to opponent…" : "Waiting for an opponent to join…",
      "info"
    );

    // Room code / password / link, shown for as long as nobody has joined.
    showRoomInvite();

    // Subscribe first, then catch up, so nothing published between the initial
    // read and the subscription is lost.
    connectRoomTransport(duel.id)
      .then(() => catchUpFromDatabase())
      .catch((err) => console.error("[Duel] transport setup failed", err));

    startEventPolling();
    renderDuelBoard();
  }

  async function sendEvent(type, payload) {
    if (!state.activeDuel) return null;

    // A client-side id lets the broadcast copy and the durable row be recognised
    // as the same event, so the receiver never applies a pick twice.
    const clientEventId = DuelEvents.newClientEventId();
    const body = { ...(payload || {}), clientEventId };

    const { event } = await apiFetch("/api/duels/events", {
      method: "POST",
      body: JSON.stringify({
        duelId: state.activeDuel.id,
        sender: state.instanceId,
        type,
        payload: body,
      }),
    });

    // Persist first, broadcast second: if the broadcast is dropped the opponent
    // still recovers the event from Postgres.
    RealtimeManager.broadcast({
      id: event?.id ?? null,
      clientEventId,
      type,
      sender: state.instanceId,
      payload: body,
      ts: Date.now(),
    }).catch(() => {});

    if (event?.id) {
      const duel = state.activeDuel;
      // Record our own event so the catch-up poll does not replay it back to us.
      const normalized = DuelEvents.normalizeEvent(
        { ...event, clientEventId },
        "poll"
      );
      if (normalized) {
        const merged = DuelEvents.mergeEvents(duel.events || [], [normalized]);
        duel.events = merged.events;
        duel.lastEventId = DuelEvents.maxEventId(merged.events);
      }
    }

    return event;
  }

  /** Ends the duel session and releases the live channel. */
  function clearActiveDuel() {
    state.activeDuel = null;
    state.pendingPickPlayer = null;
    stopEventPolling();
    setRoomStatus("", "info");
    hideRoomInvite();
    RealtimeManager.leave().catch(() => {});
  }

  async function pollEvents() {
    const duel = state.activeDuel;
    if (!duel) return;

    try {
      await catchUpFromDatabase();

      if (duel.status === "waiting") {
        const { challenge } = await apiFetch(`/api/duels/challenges/${encodeURIComponent(duel.id)}`);
        if (challenge?.joiner && duel.status !== "active") {
          duel.joiner = challenge.joiner;
          duel.status = "active";
          duel.turn = "creator";
          setRoomStatus("Opponent joined", "ok");
          hideRoomInvite();
          renderDuelBoard();
        }
      }
    } catch (err) {
      console.error("[Duel] Poll failed", err);
    }
  }

  /**
   * Applies a NORMALISED event (see js/duel-events.js). Callers must route
   * everything through ingestEvents() so dedupe and ordering are enforced —
   * the same event legitimately arrives over both transports.
   */
  function applyDuelEvent(event) {
    const duel = state.activeDuel;
    if (!duel) return;

    if (event.sender === state.instanceId) return;

    const payload = event.payload || {};
    if (event.type === "challenge_joined") {
      duel.joiner = payload.joiner;
      duel.status = "active";
      duel.turn = "creator";
      setRoomStatus("Opponent joined", "ok");
      hideRoomInvite();
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
          clearActiveDuel();
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
        clearActiveDuel();
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
          clearActiveDuel();
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
          clearActiveDuel();
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
          clearActiveDuel();
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

  // Usernames resolve after the lobby first paints; redraw so creators are
  // never left showing a raw address.
  document.addEventListener("profiles:updated", () => {
    if (lastLobbyChallenges) renderLobby(lastLobbyChallenges);
  });

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
