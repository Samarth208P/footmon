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
 *
 * Uses a Map keyed by slot_index for O(n) lookups instead of O(n²) .find().
 */
function hydrateSlots(baseSlots, serverSlots) {
  if (!Array.isArray(serverSlots) || serverSlots.length === 0) return baseSlots;

  // Build index map once → O(n) lookups instead of O(n²) nested .find()
  const slotMap = new Map();
  for (const s of serverSlots) slotMap.set(s.slot_index, s);

  let changed = false;
  const next = baseSlots.map((slot, idx) => {
    const row = slotMap.get(idx);
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
        jerseyNumber: row.jersey_number != null ? Number(row.jersey_number) : null,
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
export function useDuel(rawAddress) {
  const { walletProvider } = useAppKitProvider("eip155");

  // useAppKitAccount() returns EIP-55 checksummed addresses (mixed case),
  // but every address we persist server-side is lowercased. Normalise once
  // here so downstream equality checks against DB-sourced fields
  // (current_turn, creator, joiner, squad.player, ...) actually match —
  // without this, isMyTurn is permanently stuck at false and the Roll /
  // Claim Forfeit buttons behave as if the opponent is always on the clock.
  const address = rawAddress ? String(rawAddress).toLowerCase() : null;

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

  // Current roll (drafter's own view)
  const [nationCode, setNationCode] = useState(null);
  const [nationName, setNationName] = useState(null);
  const [year, setYear] = useState(null);
  const [squad, setSquad] = useState([]);
  const [rolledThisTurn, setRolledThisTurn] = useState(false);
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [filterPos, setFilterPos] = useState(null);

  // Mirrors of the local roll state used by the polling loop to decide
  // whether it needs to clear my roll (e.g., I picked, turn moved on).
  const nationCodeRef = useRef(nationCode);
  const yearRef = useRef(year);
  useEffect(() => { nationCodeRef.current = nationCode; }, [nationCode]);
  useEffect(() => { yearRef.current = year; }, [year]);

  // Timestamp of the last successful roll response. Polling uses it to
  // ignore stale room fetches that started BEFORE the roll POST wrote its
  // result to the DB but arrived AFTER, which would otherwise wipe out the
  // freshly-set nation/year on the client. A 3-second grace is plenty
  // longer than a normal roll round-trip.
  const rolledAtRef = useRef(0);

  // Same trick for slot rearrangement: while a rearrange POST is in flight
  // we shouldn't let the poller revert the optimistic swap with a stale
  // reading of the old slot layout.
  const rearrangeInFlightRef = useRef(false);

  // Timestamp of the last successful pick. Polling uses it to skip
  // hydrating mySlots and turn state from stale responses that started
  // before the pick was persisted.
  const pickAtRef = useRef(0);

  // Gate: when ANY mutation (pick, roll, rearrange) is in flight, the poll
  // can skip fetching because the response will be stale by the time it
  // arrives and will be superseded by the mutation's own response.
  const mutationInFlightRef = useRef(false);

  // Opponent's live roll, streamed via the room GET response so the waiting
  // player can watch what nation/year their opponent has drawn and browse
  // their available players read-only.
  const [opponentRoll, setOpponentRoll] = useState(null);

  // Timeout penalty: if I missed my previous turn, my NEXT pick is capped
  // at this rating. null means no penalty. Cleared server-side on any
  // successful pick.
  const [myPenaltyMaxRating, setMyPenaltyMaxRating] = useState(null);

  // Turn state
  const [isMyTurn, setIsMyTurn] = useState(false);
  const [turnDeadline, setTurnDeadline] = useState(null);

  // ── Instant roll cleanup on turn transitions ──────────────────────────
  // When isMyTurn changes, immediately clear the roll data belonging to
  // the "other" context so the UI doesn't flash stale opponent data in
  // the draft panel. Without this, up to 1.5s of overlap can occur between
  // turns (the time until the next poll clears the state).
  const prevIsMyTurnForRollRef = useRef(isMyTurn);
  useEffect(() => {
    const was = prevIsMyTurnForRollRef.current;
    prevIsMyTurnForRollRef.current = isMyTurn;
    if (was === isMyTurn) return;

    if (isMyTurn) {
      // Turn just came to me — clear opponent's roll immediately.
      setOpponentRoll(null);
    } else {
      // Turn just passed to opponent — clear my stale roll so it doesn't
      // flash when the panel switches to spectator mode.
      setNationCode(null);
      setNationName(null);
      setYear(null);
      setSquad([]);
      setRolledThisTurn(false);
      setSelectedPlayer(null);
      setFilterPos(null);
    }
  }, [isMyTurn]);

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

  // ── Reset draft state before a new duel ────────────────────────────────
  // Called at the start of createRoom and joinRoom so nothing lingers from
  // a previous match (mySlots showing the last squad, a half-eaten roll,
  // the wrong isMyTurn flag, etc.). resetDuel does more — it also nukes the
  // room code, session token and polling — so we can't reuse it here without
  // erasing the values we're about to set.
  const clearDraftState = useCallback(() => {
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
    setTurnDeadline(null);
    setMatchResult(null);
    setOpponentReady(false);
    setMyReady(false);
    setOpponent(null);
    setOpponentRoll(null);
    setMyPenaltyMaxRating(null);
    setError(null);
  }, [formation, style]);

  // ── Room creation ───────────────────────────────────────────────────────

  const createRoom = useCallback(async ({ stake, isPrivate = false, password = null }) => {
    if (!address) return { error: "Connect wallet first" };
    clearDraftState();
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
    clearDraftState();
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
    if (busy || !isMyTurn || !roomCode) return;
    setBusy(true);
    mutationInFlightRef.current = true;

    const isPaid = rolledThisTurn;

    try {
      if (isPaid && payForRoll) {
        await payForRoll(REROLL_PRICE_MON);
      }

      // Duel roll is server-authoritative: the server verifies it's our
      // turn, records the (nation, year) on the room so the opponent can
      // see it, and returns the squad. Reroll semantics (lock nation vs
      // lock year) are derived on the server from the room's previous roll.
      let token = sessionTokenRef.current;
      if (!token) {
        const sess = await openSession(roomCode);
        if (sess.error) throw new Error(sess.error);
        token = sess.token;
      }

      const res = await fetch(`/api/duels/rooms/${roomCode}/roll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ mode }),
      });
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
      // Record the local timestamp so an in-flight poll started before the
      // server persisted this roll can't clear our fresh state on arrival.
      rolledAtRef.current = Date.now();
      if (data.room) setRoom(data.room);
    } finally {
      mutationInFlightRef.current = false;
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, isMyTurn, rolledThisTurn, roomCode]);

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
      mutationInFlightRef.current = true;
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
        setFilterPos(null);
        setIsMyTurn(false);
        pickAtRef.current = Date.now();

        // Immediately apply the authoritative server response so the UI
        // reflects the true next-turn state without waiting for a poll tick.
        if (data.room) {
          setRoom(data.room);
          if (data.room.current_turn) {
            const nextIsMe = data.room.current_turn === addressRef.current;
            setIsMyTurn(nextIsMe);
          }
          if (data.room.turn_deadline) setTurnDeadline(data.room.turn_deadline);
          // Transition to match screen immediately if draft just completed.
          if (data.draftComplete) {
            setScreen("match");
            screenRef.current = "match";
          }
        }
      } else {
        setError(data.error || "Pick failed");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      mutationInFlightRef.current = false;
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, address, isMyTurn, mySlots, nationCode, year]);

  // ── Rearrange own slots ─────────────────────────────────────────────────
  // Swap or move two of the caller's own placed players. Legal on either
  // player's turn — this doesn't advance the draft, it just reshapes the
  // pitch. The server does the compatibility check against wc_players so a
  // dropped-in "ST as CB" won't slip through even if the client is buggy.
  const rearrangeSlots = useCallback(async (fromSlot, toSlot) => {
    if (!roomCode || fromSlot === toSlot) return { error: "Nothing to rearrange" };
    if (!Number.isInteger(fromSlot) || !Number.isInteger(toSlot)) {
      return { error: "Invalid slot" };
    }
    // Reject if a swap is already in flight — prevents concurrent rearranges
    // from fighting each other and causing visual flicker on the pitch.
    if (rearrangeInFlightRef.current) return { error: "Swap in progress" };

    let token = sessionTokenRef.current;
    if (!token) {
      const sess = await openSession(roomCode);
      if (sess.error) return { error: sess.error };
      token = sess.token;
    }

    // Optimistic local move so the pitch feels responsive. We revert if the
    // server rejects, but the happy path is the common one so we don't want
    // to wait a round-trip before showing the new layout.
    //
    // Also gate polling from rehydrating mySlots while the POST is in
    // flight — otherwise a poll that returns the pre-swap layout would
    // overwrite our optimistic move and the swap looks like it "snaps
    // back" for ~1.5s before the next poll picks up the persisted state.
    rearrangeInFlightRef.current = true;
    mutationInFlightRef.current = true;
    let snapshot;
    setMySlots((prev) => {
      snapshot = prev;
      const next = prev.map((s) => ({ ...s }));
      const a = next[fromSlot];
      const b = next[toSlot];
      const tmp = a.player;
      a.player = b.player;
      b.player = tmp;
      return next;
    });

    try {
      const res = await fetch(`/api/duels/rooms/${roomCode}/rearrange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ fromSlot, toSlot }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Revert the optimistic move.
        if (snapshot) setMySlots(snapshot);
        return { error: data.error || "Rearrange failed" };
      }
      // Hydrate from the canonical server response so the client and DB
      // agree without waiting for another poll tick.
      if (Array.isArray(data.slots)) {
        setMySlots((prev) => hydrateSlots(prev, data.slots));
      }
      return { slots: data.slots, swapped: data.swapped };
    } catch (err) {
      if (snapshot) setMySlots(snapshot);
      return { error: err.message };
    } finally {
      rearrangeInFlightRef.current = false;
      mutationInFlightRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode]);

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
        settlementTx: data.settlementTx || null,
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
        settlementTx: data.settlementTx || null,
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
      // Skip the fetch if a mutation (pick/roll/rearrange) is in flight —
      // its response will be newer than anything we'd get here.
      if (mutationInFlightRef.current) return;
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
        //
        // Skip hydrating MY slots while a rearrange POST is in flight —
        // otherwise a poll that raced ahead of the persisted swap would
        // paint the pre-swap layout back on top of the optimistic move,
        // producing a ~1.5s "snap back" that looked like broken latency.
        if (Array.isArray(data.squads)) {
          const pickedRecently = Date.now() - pickAtRef.current < 3000;
          for (const sq of data.squads) {
            const isMine = sq.player === myAddr;
            if (isMine && (rearrangeInFlightRef.current || pickedRecently)) continue;
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
        if (r.status === "simulating" || r.status === "complete") {
          setScreen("match");
        }

        // Turn state. Skip if a pick just landed — the stale poll response
        // might still carry the old current_turn from before the pick.
        const pickedRecentlyForTurn = Date.now() - pickAtRef.current < 3000;
        const nowMyTurn = r.current_turn ? r.current_turn === myAddr : false;
        if (r.current_turn && !pickedRecentlyForTurn) {
          setIsMyTurn(nowMyTurn);
        }
        if (r.turn_deadline) {
          setTurnDeadline(r.turn_deadline);
        }

        // Timeout penalty flag for me. Server tracks it per side; we mirror
        // whichever side I'm on. Null means "no penalty".
        const myPenalty = meIsCreator
          ? r.creator_penalty_max_rating
          : r.joiner_penalty_max_rating;
        setMyPenaltyMaxRating(
          myPenalty != null && myPenalty !== "" ? Number(myPenalty) : null
        );

        // Opponent's live roll. When it's their turn and the server has
        // recorded a wheel result, mirror it locally so we can render their
        // draft panel read-only. On my own turn we don't need the mirror —
        // we already own the roll state.
        if (!nowMyTurn && data.currentRoll) {
          setOpponentRoll(data.currentRoll);
        } else if (nowMyTurn || !r.current_roll_nation) {
          setOpponentRoll(null);
        }

        // If the turn passed to me while I still had a stale local roll
        // hanging around (e.g. from a previous turn), wipe it so the UI
        // shows a fresh "Roll to draw" empty state.
        //
        // Grace window: if a roll POST finished within the last 3 seconds
        // and this poll fetch was in flight during that gap, `r.current_roll_nation`
        // will still read null even though the local state is correct. Skip
        // the clear in that case — the next poll will see the persisted roll
        // and the UI will stay in sync.
        const rolledRecently = Date.now() - rolledAtRef.current < 3000;
        if (
          nowMyTurn &&
          !r.current_roll_nation &&
          !rolledRecently &&
          (nationCodeRef.current || yearRef.current)
        ) {
          setYear(null);
          setNationCode(null);
          setNationName(null);
          setSquad([]);
          setRolledThisTurn(false);
          setSelectedPlayer(null);
          setFilterPos(null);
        }
      } catch (err) {
        console.error("Poll error:", err);
      }
    };

    // Adaptive: poll fast (800ms) during drafting for responsive turns,
    // slower (2500ms) during idle phases to save bandwidth.
    const schedulePoll = () => {
      const interval = screenRef.current === "draft" ? 800 : 2500;
      pollRef.current = setTimeout(() => {
        poll();
        schedulePoll();
      }, interval);
    };
    poll();
    schedulePoll();
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
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
    setOpponentRoll(null);
    setMyPenaltyMaxRating(null);
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
    opponentRoll,
    myPenaltyMaxRating,

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
    rearrangeSlots,
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
