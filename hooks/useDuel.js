"use client";

import { useCallback, useState, useEffect, useRef } from "react";
import { BrowserProvider } from "ethers";
import { useAppKitProvider } from "@reown/appkit/react";
import { FORMATIONS, buildSlots, canPlayerFillSlot, REROLL_PRICE_MON } from "@/lib/constants";

// ── Session persistence ─────────────────────────────────────────────────────
// We stash the active duel session in localStorage so a page refresh mid-duel
// doesn't strand the user. The stored blob matches the server's TTL (6h) and
// is cleared explicitly on resetDuel / forfeit.

const SESSION_STORAGE_KEY = "footmon.duelSession";
const SESSION_STORAGE_TTL_MS = 6 * 60 * 60 * 1000; // matches lib/session.js

function persistSession(entry) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(entry));
  } catch { /* quota / privacy modes */ }
}

function readSession() {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.token || !data?.roomCode || !data?.address) return null;
    if (data.expiresAt && data.expiresAt < Date.now()) {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function clearSession() {
  if (typeof window === "undefined") return;
  try { localStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* ignore */ }
}

/**
 * 16 random bytes → 32-char lowercase hex nonce (matches server's regex).
 */
function randomNonce() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Merge server-side pick rows into a client formation grid. `baseSlots` is
 * the empty layout from buildSlots(); `serverSlots` is what the server has
 * stored for that squad. We only overwrite when something changed to keep
 * React from re-rendering the pitch on every poll tick.
 */
function hydrateSlots(baseSlots, serverSlots) {
  if (!Array.isArray(serverSlots) || serverSlots.length === 0) return baseSlots;

  let changed = false;
  const next = baseSlots.map((slot, idx) => {
    const row = serverSlots.find((s) => s.slot_index === idx);
    if (!row) {
      if (slot.player !== null) {
        changed = true;
        return { ...slot, player: null };
      }
      return slot;
    }
    // Cheap identity check — same name + same rating means the pick hasn't
    // changed, no re-render needed.
    if (slot.player?.name === row.player_name && slot.player?.rating === Number(row.player_rating)) {
      return slot;
    }
    changed = true;
    return {
      ...slot,
      player: {
        name: row.player_name,
        rating: Number(row.player_rating ?? 0),
        position: row.player_position ?? slot.pos,
        positions: row.player_position ? [row.player_position] : [slot.pos],
        draftedNation: row.player_nation ?? null,
        draftedYear: row.player_year ?? null,
      },
    };
  });
  return changed ? next : baseSlots;
}

/**
 * Message a player signs to open a duel session.
 * Must stay in sync with lib/session.js -> buildSessionMessage().
 */
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

/**
 * Hook managing duel state: lobby, room creation/joining, session, draft, match.
 *
 * The flow is deliberately staged so no player commits money without their
 * opponent being present:
 *   1. Creator posts room → gets code (server-generated duelId, stake advertised).
 *   2. Joiner posts /join with the code.
 *   3. Both players open a session (one wallet signature each) — used to auth
 *      subsequent /ready and /pick calls.
 *   4. On "Ready", each side escrows on-chain (createDuel / joinDuel) if the
 *      stake is non-zero, then posts /ready.
 *   5. Once both are ready, the draft begins.
 */
export function useDuel(address) {
  const { walletProvider } = useAppKitProvider("eip155");

  // Screen state
  const [screen, setScreen] = useState("lobby"); // "lobby" | "waiting" | "ready" | "draft" | "match" | "result"

  // Lobby state
  const [challenges, setChallenges] = useState([]);
  const [lobbyLoading, setLobbyLoading] = useState(false);

  // Room state
  const [roomCode, setRoomCode] = useState(null);
  const [room, setRoom] = useState(null);
  const [isCreator, setIsCreator] = useState(false);
  const [opponent, setOpponent] = useState(null);
  const [opponentReady, setOpponentReady] = useState(false);
  const [myReady, setMyReady] = useState(false);

  // Session token (bearer credential authorising /ready and /pick).
  const [sessionToken, setSessionToken] = useState(null);
  const sessionTokenRef = useRef(null);
  useEffect(() => { sessionTokenRef.current = sessionToken; }, [sessionToken]);

  // Persist the active session so a refresh doesn't strand the user mid-duel.
  useEffect(() => {
    if (!sessionToken || !roomCode || !address) return;
    persistSession({
      token: sessionToken,
      roomCode,
      address: String(address).toLowerCase(),
      expiresAt: Date.now() + SESSION_STORAGE_TTL_MS,
    });
  }, [sessionToken, roomCode, address]);

  // Refs used by the polling loop to avoid stale closures. The interval is
  // set up once per room; without refs it would see whatever `screen`,
  // `isCreator`, etc. were at setup time and miss subsequent transitions.
  const screenRef = useRef(screen);
  const isCreatorRef = useRef(isCreator);
  const addressRef = useRef(address);
  useEffect(() => { screenRef.current = screen; }, [screen]);
  useEffect(() => { isCreatorRef.current = isCreator; }, [isCreator]);
  useEffect(() => { addressRef.current = address; }, [address]);

  // Draft state
  const [formation, setFormationKey] = useState("4-3-3");
  const [style, setStyleKey] = useState("balanced");
  const [mySlots, setMySlots] = useState(() => buildSlots("4-3-3", "balanced"));
  const [opponentSlots, setOpponentSlots] = useState(() => buildSlots("4-3-3", "balanced"));

  // Current roll
  const [nationCode, setNationCode] = useState(null);
  const [nationName, setNationName] = useState(null);
  const [year, setYear] = useState(null);
  const [squad, setSquad] = useState([]);
  const [rolledThisTurn, setRolledThisTurn] = useState(false);
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [filterPos, setFilterPos] = useState(null);

  // Turn state
  const [isMyTurn, setIsMyTurn] = useState(false);
  const [turnDeadline, setTurnDeadline] = useState(null);

  // Match result — populated once /simulate returns the recorded goal-by-goal
  // timeline. Shape: { room, matchLogs, payoutWei, settled, settlementError }.
  const [matchResult, setMatchResult] = useState(null);
  const simulateInFlightRef = useRef(false);

  // UI state
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Modal state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [joinModalOpen, setJoinModalOpen] = useState(false);

  // Polling ref
  const pollRef = useRef(null);

  // ── Formation ───────────────────────────────────────────────────────────

  const setFormation = useCallback((key) => {
    setFormationKey(key);
    setMySlots(buildSlots(key, style));
  }, [style]);

  const setStyle = useCallback((s) => {
    setStyleKey(s);
    setMySlots(buildSlots(formation, s));
  }, [formation]);

  // ── Lobby ───────────────────────────────────────────────────────────────

  const refreshLobby = useCallback(async () => {
    setLobbyLoading(true);
    try {
      const res = await fetch("/api/duels/rooms");
      if (res.ok) {
        const data = await res.json();
        setChallenges(data.rooms || []);
      }
    } catch (err) {
      console.error("Failed to refresh lobby:", err);
    } finally {
      setLobbyLoading(false);
    }
  }, []);

  // ── Session (wallet-signed bearer token) ────────────────────────────────

  /**
   * Sign a message with the connected wallet and exchange it for a room
   * session token. The token authorises /ready and /pick calls for this
   * browser, so the user only signs once per duel.
   */
  const openSession = useCallback(async (code) => {
    if (!address) return { error: "Connect wallet first" };
    if (!walletProvider) return { error: "Wallet provider not ready" };

    try {
      const provider = new BrowserProvider(walletProvider);
      const signer = await provider.getSigner();

      const issuedAt = new Date().toISOString();
      const nonce = randomNonce();
      const message = buildSessionMessage({ address, roomCode: code, issuedAt, nonce });

      const signature = await signer.signMessage(message);

      const res = await fetch(`/api/duels/rooms/${code}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, issuedAt, nonce, signature }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { error: data.error || "Failed to open duel session" };
      }
      setSessionToken(data.token);
      return { token: data.token, side: data.side, room: data.room };
    } catch (err) {
      const rejected = err?.code === "ACTION_REJECTED" || /reject|denied/i.test(err?.message || "");
      return { error: rejected ? "Signature cancelled" : (err.message || "Failed to open session") };
    }
  }, [address, walletProvider]);

  // ── Room creation ───────────────────────────────────────────────────────

  const createRoom = useCallback(async ({ stake, isPrivate = false, password = null }) => {
    if (!address) return { error: "Connect wallet first" };
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/duels/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creator: address,
          stake: String(stake ?? "0"),
          isPrivate,
          password: password || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create room");
        return { error: data.error || "Failed to create room" };
      }

      setRoom(data.room);
      setRoomCode(data.room.room_code);
      setIsCreator(true);
      isCreatorRef.current = true;
      setScreen("waiting");
      screenRef.current = "waiting";
      setCreateModalOpen(false);

      // Open the session immediately so the creator only sees one wallet
      // popup at room-creation time. The joiner opens theirs when they join.
      const sess = await openSession(data.room.room_code);
      if (sess.error) {
        // Non-fatal: we can retry when the user hits "Ready".
        setError(sess.error);
      }

      // Start polling for opponent
      startPolling(data.room.room_code);

      return { room: data.room };
    } catch (err) {
      setError(err.message);
      return { error: err.message };
    } finally {
      setBusy(false);
    }
    // startPolling and openSession are declared later; deps intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // ── Room joining ────────────────────────────────────────────────────────

  /**
   * Look up a room by code so the caller can inspect stake before staking.
   */
  const fetchRoomByCode = useCallback(async (code) => {
    try {
      const res = await fetch(`/api/duels/rooms/${code}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) return { error: data.error || "Room not found" };
      return { room: data.room };
    } catch (err) {
      return { error: err.message };
    }
  }, []);

  const joinRoom = useCallback(async (code, password = null) => {
    if (!address) return { error: "Connect wallet first" };
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/duels/rooms/${code}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          joiner: address,
          password: password || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to join room");
        return { error: data.error || "Failed to join room" };
      }

      setRoom(data.room);
      setRoomCode(code);
      setIsCreator(false);
      isCreatorRef.current = false;
      setOpponent(data.room.creator);
      setScreen("ready");
      screenRef.current = "ready";
      setJoinModalOpen(false);

      // Session opens the wallet popup once; token authorises ready/pick.
      const sess = await openSession(code);
      if (sess.error) {
        setError(sess.error);
      }

      // Start polling for room state
      startPolling(code);

      return { room: data.room };
    } catch (err) {
      setError(err.message);
      return { error: err.message };
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // ── Ready up ────────────────────────────────────────────────────────────

  /**
   * Ready flow:
   *   1. If the room has a stake and a contract callable is provided, escrow
   *      on-chain (createDuel for creator, joinDuel for joiner).
   *   2. Ensure we have a session token (retry openSession if not).
   *   3. POST /ready with the session bearer token.
   *
   * @param {object} opts
   * @param {(duelId: string, stakeMon: string) => Promise<any>} [opts.escrowAsCreator]
   * @param {(duelId: string) => Promise<any>} [opts.escrowAsJoiner]
   * @param {(mon: string) => string} [opts.formatStake]
   */
  const readyUp = useCallback(async ({ escrowAsCreator, escrowAsJoiner, formatStake } = {}) => {
    if (!roomCode || !address || !room) return { error: "No room" };
    setBusy(true);
    setError(null);

    try {
      const stakeWei = BigInt(room.stake ?? "0");
      const needsEscrow = stakeWei > 0n;

      // 1) On-chain escrow (if applicable).
      if (needsEscrow) {
        const stakeMon = typeof formatStake === "function"
          ? formatStake(room.stake)
          : String(room.stake);
        try {
          if (isCreator && escrowAsCreator) {
            await escrowAsCreator(room.duel_id, stakeMon);
          } else if (!isCreator && escrowAsJoiner) {
            await escrowAsJoiner(room.duel_id);
          } else {
            setError("Escrow handler missing");
            return { error: "Escrow handler missing" };
          }
        } catch (err) {
          const rejected = err?.code === "ACTION_REJECTED" || /reject|denied/i.test(err?.message || "");
          const msg = rejected ? "Transaction cancelled" : (err?.message || "Failed to escrow");
          setError(msg);
          return { error: msg };
        }
      }

      // 2) Ensure session token exists.
      let token = sessionTokenRef.current;
      if (!token) {
        const sess = await openSession(roomCode);
        if (sess.error) {
          setError(sess.error);
          return { error: sess.error };
        }
        token = sess.token;
      }

      // 3) POST /ready with the bearer token.
      const res = await fetch(`/api/duels/rooms/${roomCode}/ready`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to ready up");
        return { error: data.error || "Failed to ready up" };
      }

      setMyReady(true);
      setRoom(data.room);
      if (data.bothReady) {
        setScreen("draft");
        setIsMyTurn(data.room.current_turn === address);
      }
      return { room: data.room, bothReady: data.bothReady };
    } catch (err) {
      setError(err.message);
      return { error: err.message };
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, address, room, isCreator]);

  // ── Roll ────────────────────────────────────────────────────────────────

  const roll = useCallback(async (mode = "full", payForRoll = null) => {
    if (busy || !isMyTurn) return;
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
      setYear(data.year);
      setNationCode(data.nationCode);
      setNationName(data.nationName);
      setSquad(data.squad || []);
      setRolledThisTurn(true);
      setSelectedPlayer(null);
      setFilterPos(null);
    } finally {
      setBusy(false);
    }
  }, [busy, isMyTurn, rolledThisTurn, year, nationCode]);

  // ── Pick player ─────────────────────────────────────────────────────────

  const pickPlayer = useCallback(async (player, slotIdx) => {
    if (!roomCode || !address || !isMyTurn) return;

    const slot = mySlots[slotIdx];
    if (!slot || slot.player || !canPlayerFillSlot(player, slot.pos)) return;

    // Block if same player name (from a different year) is already in the squad
    const nameAlreadyUsed = mySlots.some(
      (s) => s.player && s.player.name === player.name && s.player.id !== player.id
    );
    if (nameAlreadyUsed) return;

    // Ensure we have a session token before hitting an authenticated endpoint.
    let token = sessionTokenRef.current;
    if (!token) {
      const sess = await openSession(roomCode);
      if (sess.error) {
        setError(sess.error);
        return;
      }
      token = sess.token;
    }

    setBusy(true);

    try {
      const res = await fetch(`/api/duels/rooms/${roomCode}/pick`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          slotIndex: slotIdx,
          slotPos: slot.pos,
          playerName: player.name,
          playerPositions: player.positions || [player.position],
          playerRating: player.rating,
          nation: nationCode,
          year,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        // Update local slots
        setMySlots((prev) => {
          const next = [...prev];
          next[slotIdx] = { ...next[slotIdx], player: { ...player, draftedNation: nationCode, draftedYear: year } };
          return next;
        });

        // Reset draft state
        setYear(null);
        setNationCode(null);
        setNationName(null);
        setSquad([]);
        setRolledThisTurn(false);
        setSelectedPlayer(null);
        setIsMyTurn(false);
      } else {
        setError(data.error || "Pick failed");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, address, isMyTurn, mySlots, nationCode, year]);

  // ── Simulate the match ──────────────────────────────────────────────────

  /**
   * Kicks off the server-side simulation and pulls back the recorded
   * goal-by-goal log. Safe to call more than once: the server is idempotent
   * — a repeated call returns the stored logs instead of re-rolling the
   * result. We still gate on a ref locally so we don't fire N parallel
   * requests while the first one is in flight.
   */
  const simulateMatch = useCallback(async () => {
    if (!roomCode) return { error: "No room" };
    if (simulateInFlightRef.current) return { pending: true };
    simulateInFlightRef.current = true;

    try {
      let token = sessionTokenRef.current;
      if (!token) {
        const sess = await openSession(roomCode);
        if (sess.error) return { error: sess.error };
        token = sess.token;
      }

      const res = await fetch(`/api/duels/rooms/${roomCode}/simulate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json();
      if (!res.ok) return { error: data.error || "Simulation failed" };

      setMatchResult({
        room: data.room,
        matchLogs: data.matchLogs || [],
        settled: Boolean(data.settled),
        settlementError: data.settlementError || null,
        payoutWei: data.payoutWei || "0",
      });
      if (data.room) setRoom(data.room);
      return { result: data };
    } catch (err) {
      return { error: err.message };
    } finally {
      simulateInFlightRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode]);

  // ── Claim forfeit when the opponent's turn clock has run out ────────────

  const claimForfeit = useCallback(async () => {
    if (!roomCode || !address) return { error: "No room" };
    const token = sessionTokenRef.current;
    if (!token) return { error: "No session token" };

    try {
      const res = await fetch(`/api/duels/rooms/${roomCode}/forfeit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason: "timeout" }),
      });
      const data = await res.json();
      if (!res.ok) return { error: data.error || "Failed to claim forfeit" };

      // The forfeit endpoint moves the room to 'complete'. Reuse the match
      // result shape so the DuelMatchScreen can render the reveal directly.
      setMatchResult({
        room: data.room,
        matchLogs: [],
        settled: Boolean(data.settled),
        settlementError: data.settlementError || null,
        payoutWei: data.payoutWei || "0",
        forfeit: true,
      });
      if (data.room) setRoom(data.room);
      setScreen("match");
      screenRef.current = "match";
      return { room: data.room };
    } catch (err) {
      return { error: err.message };
    }
  }, [roomCode, address]);

  // ── Cancel / forfeit ────────────────────────────────────────────────────

  const cancelRoom = useCallback(async () => {
    if (!roomCode || !address) return;
    setBusy(true);

    try {
      const token = sessionTokenRef.current;
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(`/api/duels/rooms/${roomCode}/forfeit`, {
        method: "POST",
        headers,
      });

      if (res.ok) {
        stopPolling();
        clearSession();
        resetDuel();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, address]);

  // ── Polling ─────────────────────────────────────────────────────────────

  const startPolling = useCallback((code) => {
    stopPolling();

    const poll = async () => {
      try {
        const res = await fetch(`/api/duels/rooms/${code}`, { cache: "no-store" });
        if (!res.ok) return;

        const data = await res.json();
        const r = data.room;
        if (!r) return;

        // Read live state through refs so this interval sees the current
        // screen / isCreator / address rather than the values captured when
        // startPolling was first called.
        const myAddr = addressRef.current;
        const meIsCreator = isCreatorRef.current;
        const currentScreen = screenRef.current;

        setRoom(r);

        // Opponent — always the address that is NOT me.
        const opp = r.creator === myAddr ? r.joiner : r.creator;
        if (opp) setOpponent((prev) => (prev === opp ? prev : opp));

        // Stream both sides' picks into the local pitch grids. Server sends
        // this block once we're past the ready phase, so we can render each
        // player's team growing in real time.
        if (Array.isArray(data.squads)) {
          for (const sq of data.squads) {
            const isMine = sq.player === myAddr;
            const target = isMine ? setMySlots : setOpponentSlots;
            target((prev) => hydrateSlots(prev, sq.slots));
          }
        }

        // Ready flags from my perspective.
        setMyReady(meIsCreator ? Boolean(r.creator_ready) : Boolean(r.joiner_ready));
        setOpponentReady(meIsCreator ? Boolean(r.joiner_ready) : Boolean(r.creator_ready));

        // Screen transitions driven by server state.
        //   waiting -> ready  once the joiner is in
        //   ready   -> draft  once both are ready
        //   *       -> match  once the draft finishes
        if (
          r.status === "full" &&
          (currentScreen === "waiting" || currentScreen === "ready")
        ) {
          setScreen("ready");
        }
        if (r.status === "ready" && currentScreen !== "ready" && currentScreen !== "draft") {
          setScreen("ready");
        }
        if (
          r.status === "drafting" &&
          (currentScreen === "ready" || currentScreen === "waiting")
        ) {
          setScreen("draft");
        }
        if (r.status === "simulating" || r.status === "completed") {
          setScreen("match");
        }

        // Turn state.
        if (r.current_turn) {
          setIsMyTurn(r.current_turn === myAddr);
        }
        if (r.turn_deadline) {
          setTurnDeadline(r.turn_deadline);
        }
      } catch (err) {
        console.error("Poll error:", err);
      }
    };

    poll();
    pollRef.current = setInterval(poll, 1500);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // ── Reset ───────────────────────────────────────────────────────────────

  const resetDuel = useCallback(() => {
    stopPolling();
    clearSession();
    setScreen("lobby");
    screenRef.current = "lobby";
    setRoom(null);
    setRoomCode(null);
    setIsCreator(false);
    isCreatorRef.current = false;
    setOpponent(null);
    setOpponentReady(false);
    setMyReady(false);
    setSessionToken(null);
    setMatchResult(null);
    setMySlots(buildSlots(formation, style));
    setOpponentSlots(buildSlots(formation, style));
    setYear(null);
    setNationCode(null);
    setNationName(null);
    setSquad([]);
    setRolledThisTurn(false);
    setSelectedPlayer(null);
    setFilterPos(null);
    setIsMyTurn(false);
    setError(null);
  }, [formation, style, stopPolling]);

  // ── Stats ───────────────────────────────────────────────────────────────

  const getMyStats = useCallback(() => {
    const filled = mySlots.filter((s) => s.player);
    const total = mySlots.length;
    const assigned = filled.length;
    if (assigned === 0) return { avg: "0.0", attack: 0, defense: 0, assigned, total };

    const avg = filled.reduce((s, sl) => s + sl.player.rating, 0) / assigned;
    const attack = filled.reduce((s, sl) => s + (sl.player.attack ?? sl.player.rating), 0) / assigned;
    const defense = filled.reduce((s, sl) => s + (sl.player.defense ?? sl.player.rating), 0) / assigned;

    return { avg: avg.toFixed(1), attack: Math.round(attack), defense: Math.round(defense), assigned, total };
  }, [mySlots]);

  const getOpponentStats = useCallback(() => {
    const filled = opponentSlots.filter((s) => s.player);
    const total = opponentSlots.length;
    const assigned = filled.length;
    if (assigned === 0) return { avg: "0.0", attack: 0, defense: 0, assigned, total };

    const avg = filled.reduce((s, sl) => s + sl.player.rating, 0) / assigned;
    return { avg: avg.toFixed(1), attack: 0, defense: 0, assigned, total };
  }, [opponentSlots]);

  const isSquadComplete = mySlots.every((s) => s.player !== null);
  const assignedIds = new Set(mySlots.filter((s) => s.player).map((s) => s.player.id));
  const assignedNames = new Set(mySlots.filter((s) => s.player).map((s) => s.player.name));

  // Filtered squad
  const filteredSquad = filterPos
    ? squad.filter((p) => p.positions?.includes(filterPos))
    : squad;

  // Cleanup on unmount
  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  // ── Reconnect from a persisted session on mount ─────────────────────────
  // If the tab was refreshed mid-duel, restore roomCode + token, fetch the
  // room state, work out which screen to land on, and start polling. No
  // wallet popup is triggered — the stored token is still valid.
  const reconnectAttemptedRef = useRef(false);
  useEffect(() => {
    if (reconnectAttemptedRef.current) return;
    if (!address) return; // wait until wallet is known
    reconnectAttemptedRef.current = true;

    const stored = readSession();
    if (!stored) return;
    if (stored.address.toLowerCase() !== String(address).toLowerCase()) {
      clearSession();
      return;
    }

    (async () => {
      try {
        const res = await fetch(`/api/duels/rooms/${stored.roomCode}`, { cache: "no-store" });
        if (!res.ok) {
          clearSession();
          return;
        }
        const data = await res.json();
        const r = data.room;
        if (!r) {
          clearSession();
          return;
        }
        // Room is dead → forget the session.
        if (["cancelled", "expired"].includes(r.status)) {
          clearSession();
          return;
        }

        const iAmCreator = r.creator === String(address).toLowerCase();
        const nextScreen =
          r.status === "open" ? "waiting" :
          r.status === "full" || r.status === "ready" ? "ready" :
          r.status === "drafting" ? "draft" :
          (r.status === "simulating" || r.status === "complete") ? "match" :
          "lobby";

        setSessionToken(stored.token);
        setRoomCode(stored.roomCode);
        setRoom(r);
        setIsCreator(iAmCreator);
        isCreatorRef.current = iAmCreator;
        setOpponent(iAmCreator ? r.joiner : r.creator);
        setMyReady(Boolean(iAmCreator ? r.creator_ready : r.joiner_ready));
        setOpponentReady(Boolean(iAmCreator ? r.joiner_ready : r.creator_ready));
        setScreen(nextScreen);
        screenRef.current = nextScreen;

        // Hydrate slots immediately if the response already carries them.
        if (Array.isArray(data.squads)) {
          for (const sq of data.squads) {
            const isMine = sq.player === String(address).toLowerCase();
            const target = isMine ? setMySlots : setOpponentSlots;
            target((prev) => hydrateSlots(prev, sq.slots));
          }
        }

        startPolling(stored.roomCode);
      } catch {
        clearSession();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  return {
    // Screen
    screen,
    setScreen,

    // Lobby
    challenges,
    lobbyLoading,
    refreshLobby,

    // Room
    roomCode,
    room,
    isCreator,
    opponent,
    opponentReady,
    myReady,
    sessionToken,

    // Formation
    formation,
    style,
    setFormation,
    setStyle,

    // Slots
    mySlots,
    opponentSlots,

    // Draft
    nationCode,
    nationName,
    year,
    squad,
    filteredSquad,
    rolledThisTurn,
    selectedPlayer,
    setSelectedPlayer,
    filterPos,
    setFilterPos,
    assignedIds,
    assignedNames,

    // Turn
    isMyTurn,
    turnDeadline,

    // UI
    busy,
    error,
    setError,
    createModalOpen,
    setCreateModalOpen,
    joinModalOpen,
    setJoinModalOpen,

    // Actions
    createRoom,
    joinRoom,
    fetchRoomByCode,
    openSession,
    readyUp,
    roll,
    pickPlayer,
    simulateMatch,
    matchResult,
    claimForfeit,
    cancelRoom,
    resetDuel,

    // Stats
    getMyStats,
    getOpponentStats,
    isSquadComplete,
  };
}
