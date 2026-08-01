"use client";

import { useCallback, useState, useEffect, useRef } from "react";
import { FORMATIONS, buildSlots, canPlayerFillSlot, REROLL_PRICE_MON } from "@/lib/constants";

/**
 * Hook managing duel state: lobby, room creation/joining, draft, and match.
 */
export function useDuel(address) {
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

  // ── Room creation ───────────────────────────────────────────────────────

  const createRoom = useCallback(async ({ duelId, isPrivate = false, password = null }) => {
    if (!address) return { error: "Connect wallet first" };
    if (!duelId) return { error: "Missing duelId" };
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/duels/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          duelId,
          creator: address,
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
      setScreen("waiting");
      setCreateModalOpen(false);

      // Start polling for opponent
      startPolling(data.room.room_code);

      return { room: data.room };
    } catch (err) {
      setError(err.message);
      return { error: err.message };
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // ── Room joining ────────────────────────────────────────────────────────

  /**
   * Look up a room by code so the caller can escrow on-chain first.
   * Returns { room } on success or { error }.
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
      setOpponent(data.room.creator);
      setScreen("ready");
      setJoinModalOpen(false);

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

  const readyUp = useCallback(async () => {
    if (!roomCode || !address) return;
    setBusy(true);
    
    try {
      const res = await fetch(`/api/duels/rooms/${roomCode}/ready`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player: address }),
      });
      
      const data = await res.json();
      if (res.ok) {
        setMyReady(true);
        if (data.bothReady) {
          setScreen("draft");
          setIsMyTurn(data.currentTurn === address);
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [roomCode, address]);

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
    
    setBusy(true);
    
    try {
      const res = await fetch(`/api/duels/rooms/${roomCode}/pick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          player: address,
          slotIndex: slotIdx,
          slotPos: slot.pos,
          playerName: player.name,
          playerPosition: player.position,
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
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [roomCode, address, isMyTurn, mySlots, nationCode, year]);

  // ── Cancel / forfeit ────────────────────────────────────────────────────

  const cancelRoom = useCallback(async () => {
    if (!roomCode || !address) return;
    setBusy(true);
    
    try {
      const res = await fetch(`/api/duels/rooms/${roomCode}/forfeit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player: address }),
      });
      
      if (res.ok) {
        stopPolling();
        resetDuel();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [roomCode, address]);

  // ── Polling ─────────────────────────────────────────────────────────────

  const startPolling = useCallback((code) => {
    stopPolling();
    
    const poll = async () => {
      try {
        const res = await fetch(`/api/duels/rooms/${code}`);
        if (res.ok) {
          const data = await res.json();
          const r = data.room;
          setRoom(r);
          
          // Update opponent
          if (r.joiner && !opponent) {
            setOpponent(isCreator ? r.joiner : r.creator);
            if (screen === "waiting") setScreen("ready");
          }
          
          // Update ready state
          if (isCreator) {
            setOpponentReady(r.joiner_ready);
          } else {
            setOpponentReady(r.creator_ready);
          }
          
          // Check if draft started
          if (r.status === "drafting" && screen === "ready") {
            setScreen("draft");
            setIsMyTurn(r.current_turn === address);
          }
          
          // Update turn
          if (r.current_turn) {
            setIsMyTurn(r.current_turn === address);
          }
          
          // Check if match
          if (r.status === "simulating" || r.status === "completed") {
            setScreen("match");
          }
        }
      } catch (err) {
        console.error("Poll error:", err);
      }
    };
    
    poll();
    pollRef.current = setInterval(poll, 2000);
  }, [address, isCreator, opponent, screen]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // ── Reset ───────────────────────────────────────────────────────────────

  const resetDuel = useCallback(() => {
    stopPolling();
    setScreen("lobby");
    setRoom(null);
    setRoomCode(null);
    setIsCreator(false);
    setOpponent(null);
    setOpponentReady(false);
    setMyReady(false);
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
    readyUp,
    roll,
    pickPlayer,
    cancelRoom,
    resetDuel,
    
    // Stats
    getMyStats,
    getOpponentStats,
    isSquadComplete,
  };
}
