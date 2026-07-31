// js/duel-room.js — duel room lifecycle against the escrow contract + API.
//
// Money flow: stakes are escrowed in the FootMon contract (createDuel/joinDuel)
// and pulled by the winner (claimDuelPrize). Nothing is ever sent peer-to-peer.
//
// Authority: the server decides turns, pick legality and the match result. This
// module asks; it never assumes. That is why a rejected pick simply surfaces the
// server's reason instead of being applied locally first.

const DuelRoom = (() => {
  const state = {
    room: null,
    token: null,
    side: null,
    myAddress: null,
    matchLogs: [],
    replayTimer: null,
    invitePassword: null,
  };

  // ── Invite links ──────────────────────────────────────────────────────────

  /**
   * Share link for a room. The password rides in the URL FRAGMENT, which is
   * never sent to the server or written to server logs, unlike a query string.
   */
  function shareLinkFor(roomCode, password) {
    const base = `${location.origin}/duel/${encodeURIComponent(roomCode)}`;
    if (!password) return base;
    return `${base}#pw=${encodeURIComponent(password)}`;
  }

  /** Reads /duel/<code> plus #pw= from the current URL. */
  function parseInvite(href = location.href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return null;
    }

    const match = url.pathname.match(/^\/duel\/([A-Za-z0-9]{6,10})\/?$/);
    if (!match) return null;

    const code = match[1].toUpperCase();
    let password = null;
    if (url.hash.startsWith("#")) {
      const params = new URLSearchParams(url.hash.slice(1));
      password = params.get("pw");
    }
    return { code, password };
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  async function api(path, { method = "GET", body, auth = false } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (auth) {
      if (!state.token) throw new Error("No duel session — sign in to this room first");
      headers.Authorization = `Bearer ${state.token}`;
    }

    const res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(payload.error || payload.details || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return payload;
  }

  // ── Session ───────────────────────────────────────────────────────────────

  // ⚠️ Must stay byte-identical to buildSessionMessage() in lib/session.js.
  function buildSessionMessage({ address, roomCode, issuedAt, nonce }) {
    return [
      "FootMon duel session",
      "",
      `Address: ${String(address).toLowerCase()}`,
      `Room: ${roomCode}`,
      `Issued At: ${issuedAt}`,
      `Nonce: ${nonce}`,
      "",
      "Signing authorises this browser to make your draft picks in this room.",
      "It costs no gas and sends no transaction.",
    ].join("\n");
  }

  function randomNonce() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** One signature per room buys a token for every later pick. */
  async function openSession(roomCode) {
    const address = WalletManager.getAddress();
    if (!address) throw new Error("Connect your wallet first");

    const payload = {
      address: address.toLowerCase(),
      roomCode,
      issuedAt: new Date().toISOString(),
      nonce: randomNonce(),
    };

    const signature = await WalletManager.getSigner().signMessage(buildSessionMessage(payload));
    const result = await api(`/api/duels/rooms/${roomCode}/session`, {
      method: "POST",
      body: { ...payload, signature },
    });

    state.token = result.token;
    state.room = result.room;
    state.side = result.side;
    state.myAddress = address.toLowerCase();
    return result;
  }

  // ── Create / join ─────────────────────────────────────────────────────────

  /**
   * Escrows the stake on-chain, then registers the room.
   *
   * On-chain FIRST, deliberately: if the API call fails afterwards the stake is
   * still recoverable with cancelDuel/refundExpiredDuel, whereas registering a
   * room for an unfunded duel would advertise a duel nobody can actually win.
   */
  async function createRoom({ stakeMon, isPrivate = false, password = null }) {
    const address = WalletManager.getAddress();
    if (!address) throw new Error("Connect your wallet first");

    const stake = Number(stakeMon);
    if (!Number.isFinite(stake) || stake <= 0) throw new Error("Enter a stake greater than zero");
    if (isPrivate && (!password || password.length < 4)) {
      throw new Error("A private room needs a password of at least 4 characters");
    }

    const duelId = ContractManager.newDuelId();
    const escrow = await ContractManager.createDuel(duelId, stake);

    const { room } = await api("/api/duels/rooms", {
      method: "POST",
      body: { duelId, creator: address.toLowerCase(), isPrivate, password },
    });

    state.room = room;
    state.myAddress = address.toLowerCase();
    state.side = "creator";
    state.invitePassword = isPrivate ? password : null;

    return { room, escrowTx: escrow.txHash, shareLink: shareLinkFor(room.room_code, password) };
  }

  /**
   * Matches the stake on-chain, then claims the room seat.
   *
   * The password is checked by the server BEFORE the room is mutated, but the
   * stake must already be escrowed for the join to be accepted — so we verify the
   * password first with a cheap read to avoid making the player pay gas only to
   * be told the password was wrong.
   */
  async function joinRoom(roomCode, password = null) {
    const address = WalletManager.getAddress();
    if (!address) throw new Error("Connect your wallet first");

    const code = String(roomCode).trim().toUpperCase();
    const { room } = await api(`/api/duels/rooms/${code}`);

    if (!room) throw new Error("Room not found");
    if (room.creator === address.toLowerCase()) throw new Error("You cannot join your own duel");
    if (room.joiner) throw new Error("This duel already has an opponent");

    const escrow = await ContractManager.joinDuel(room.duel_id);

    const result = await api(`/api/duels/rooms/${code}/join`, {
      method: "POST",
      body: { joiner: address.toLowerCase(), password },
    });

    state.room = result.room;
    state.myAddress = address.toLowerCase();
    state.side = "joiner";

    return { room: result.room, escrowTx: escrow.txHash };
  }

  async function cancel() {
    if (!state.room) throw new Error("No active room");
    const tx = await ContractManager.cancelDuel(state.room.duel_id);
    return tx;
  }

  // ── Ready / draft ─────────────────────────────────────────────────────────

  async function ready() {
    if (!state.room) throw new Error("No active room");
    const result = await api(`/api/duels/rooms/${state.room.room_code}/ready`, {
      method: "POST",
      auth: true,
    });
    state.room = result.room;
    return result;
  }

  /** Submits a pick. The server validates turn + position and may reject it. */
  async function pick({ slotIndex, playerName, playerPositions, playerRating, nation, year }) {
    if (!state.room) throw new Error("No active room");
    const result = await api(`/api/duels/rooms/${state.room.room_code}/pick`, {
      method: "POST",
      auth: true,
      body: { slotIndex, playerName, playerPositions, playerRating, nation, year },
    });
    state.room = result.room;
    return result;
  }

  async function claimForfeit(reason = "timeout") {
    if (!state.room) throw new Error("No active room");
    const result = await api(`/api/duels/rooms/${state.room.room_code}/forfeit`, {
      method: "POST",
      auth: true,
      body: { reason },
    });
    state.room = result.room;
    return result;
  }

  // ── Match ─────────────────────────────────────────────────────────────────

  /** Asks the server to run the match. Safe to call twice. */
  async function simulate() {
    if (!state.room) throw new Error("No active room");
    const result = await api(`/api/duels/rooms/${state.room.room_code}/simulate`, {
      method: "POST",
      auth: true,
    });
    state.room = result.room;
    state.matchLogs = result.matchLogs || [];
    return result;
  }

  async function refresh({ withState = true } = {}) {
    if (!state.room) return null;
    const query = withState ? "?state=1" : "";
    const result = await api(`/api/duels/rooms/${state.room.room_code}${query}`);
    state.room = result.room;
    if (result.matchLogs) state.matchLogs = result.matchLogs;
    return result;
  }

  async function claimPrize() {
    return ContractManager.claimDuelPrize();
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  const getRoom = () => state.room;
  const getMatchLogs = () => state.matchLogs;
  const getSide = () => state.side;
  const getToken = () => state.token;
  const hasSession = () => Boolean(state.token);
  const getInvitePassword = () => state.invitePassword;

  function currentScreen() {
    return DuelScreen.screenForRoom(state.room, state.matchLogs);
  }

  function outcome() {
    return DuelScreen.outcomeFor(state.room, state.myAddress);
  }

  function reset() {
    if (state.replayTimer) clearInterval(state.replayTimer);
    state.room = null;
    state.token = null;
    state.side = null;
    state.matchLogs = [];
    state.replayTimer = null;
    state.invitePassword = null;
  }

  function setRoom(room) {
    state.room = room;
  }

  function setMatchLogs(logs) {
    state.matchLogs = Array.isArray(logs) ? logs : [];
  }

  function setMyAddress(address) {
    state.myAddress = address ? String(address).toLowerCase() : null;
  }

  return {
    // links
    shareLinkFor,
    parseInvite,
    // lifecycle
    openSession,
    createRoom,
    joinRoom,
    cancel,
    ready,
    pick,
    claimForfeit,
    simulate,
    refresh,
    claimPrize,
    // state
    getRoom,
    setRoom,
    getMatchLogs,
    setMatchLogs,
    getSide,
    getToken,
    hasSession,
    getInvitePassword,
    setMyAddress,
    currentScreen,
    outcome,
    reset,
    buildSessionMessage,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = DuelRoom;
}
