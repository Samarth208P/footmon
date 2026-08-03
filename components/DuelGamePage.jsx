"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useAppKitAccount } from "@reown/appkit/react";
import { useContract } from "@/hooks/useContract";
import { useDuel } from "@/hooks/useDuel";
import { useProfile } from "@/hooks/useProfile";
import WalletGate from "./WalletGate";
import PitchView from "./PitchView";
import ProfileClaimModal from "./ProfileClaimModal";
import DuelMatchScreen from "./DuelMatchScreen";
import Toast from "./Toast";
import SoundToggle from "./SoundToggle";
import { getFlagUrl, canPlayerFillSlot, ratingColor, REROLL_PRICE_MON, FORMATIONS } from "@/lib/constants";
import { play as playSound, unlockOnFirstGesture } from "@/lib/sound";

/** Wei string → decimal MON string. */
function weiToMon(wei) {
  const s = String(wei ?? "0").padStart(19, "0");
  const whole = s.slice(0, -18) || "0";
  const frac = s.slice(-18).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Turn countdown clock. Renders remaining seconds against a deadline ISO
 * string; ticks itself once a second and reports whether the clock has
 * expired via the render prop. When it's the local player's turn we
 * also chirp a heartbeat at the last few seconds and play a buzzer on
 * expiry — silent when it's the opponent's clock to keep the audio
 * peripheral.
 */
function TurnCountdown({ deadline, children, isMyTurn = false }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [deadline]);

  const target = deadline ? Date.parse(deadline) : null;
  const secondsLeft = target ? Math.max(0, Math.ceil((target - now) / 1000)) : null;
  const expired = target != null && now > target;

  // Sound thresholds: warn at 10s and every second under 5s; buzzer once
  // on the first expired frame. Ref-guarded so a re-render doesn't retrigger.
  const lastWarnSecondRef = useRef(null);
  const buzzedRef = useRef(false);
  useEffect(() => {
    if (!isMyTurn || !deadline) {
      lastWarnSecondRef.current = null;
      buzzedRef.current = false;
      return;
    }
    if (expired) {
      if (!buzzedRef.current) {
        buzzedRef.current = true;
        playSound("timerExpire");
      }
      return;
    }
    buzzedRef.current = false;
    if (secondsLeft == null) return;
    // Chirp at 10s and every second from 5 down.
    if (secondsLeft === 10 || (secondsLeft <= 5 && secondsLeft >= 1)) {
      if (lastWarnSecondRef.current !== secondsLeft) {
        lastWarnSecondRef.current = secondsLeft;
        playSound("timerWarn");
      }
    }
  }, [isMyTurn, deadline, secondsLeft, expired]);

  return children({ secondsLeft, expired });
}

export default function DuelGamePage() {
  const { address, isConnected } = useAppKitAccount();
  const contract = useContract();
  const duel = useDuel(address);
  const profile = useProfile();

  const [toasts, setToasts] = useState([]);
  const [stakeInput, setStakeInput] = useState("0.1");
  const [isPrivate, setIsPrivate] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [joinPasswordInput, setJoinPasswordInput] = useState("");

  // Join-modal staged flow. We only ever render a password input once a
  // privacy probe against GET /api/duels/rooms/:code confirms the room is
  // private. Public rooms and unresolved codes never see the field. See
  // `.kiro/specs/room-password-prompt-when-none-set/design.md`.
  //   "idle"              — code entered but no probe result yet
  //   "probing"           — a probe is in flight
  //   "awaiting-password" — probe returned a private room; password field visible
  //   "not-found"         — probe returned 404; show a distinct message
  //   "error"             — probe returned some other error; show a message
  const [joinStage, setJoinStage] = useState("idle");
  const [joinProbeError, setJoinProbeError] = useState(null);
  const [probedRoom, setProbedRoom] = useState(null); // { room_code, is_private, ... }
  // Monotonic sequence used to ignore stale probe responses when the user
  // types faster than the previous probe can resolve.
  const joinProbeSeqRef = useRef(0);

  // Slot rearrangement — track the currently "held" slot so a second click
  // swaps its contents with the destination. null means no swap in flight.
  const [swapFromIdx, setSwapFromIdx] = useState(null);

  // Probe the room by code and drive `joinStage` from the result. Ignores
  // stale responses via `joinProbeSeqRef` so a fast-typing user doesn't get
  // a race between the second-to-last and last keystrokes' probes.
  const runJoinProbe = useCallback(async (rawCode) => {
    const code = String(rawCode ?? "").trim().toUpperCase();
    if (!code) {
      setJoinStage("idle");
      setProbedRoom(null);
      setJoinProbeError(null);
      return { status: "empty" };
    }
    const seq = ++joinProbeSeqRef.current;
    setJoinStage("probing");
    setJoinProbeError(null);
    let result;
    try {
      result = await duel.fetchRoomByCode(code);
    } catch (err) {
      if (seq !== joinProbeSeqRef.current) return { status: "stale" };
      setProbedRoom(null);
      setJoinStage("error");
      setJoinProbeError(err?.message || "Failed to look up room");
      return { status: "error" };
    }
    if (seq !== joinProbeSeqRef.current) return { status: "stale" };
    if (result?.error) {
      setProbedRoom(null);
      if (result.error === "Room not found") {
        setJoinStage("not-found");
        return { status: "not-found" };
      }
      setJoinStage("error");
      setJoinProbeError(result.error);
      return { status: "error" };
    }
    const room = result?.room;
    if (!room || typeof room !== "object") {
      setProbedRoom(null);
      setJoinStage("error");
      setJoinProbeError("Failed to look up room");
      return { status: "error" };
    }
    setProbedRoom(room);
    // Public rooms stay in "idle" but with `probedRoom` set — that's the
    // signal handleJoinSubmit uses to submit without a password prompt.
    setJoinStage(room.is_private ? "awaiting-password" : "idle");
    return { status: room.is_private ? "private" : "public", room };
  }, [duel]);

  // Parse join code from URL on mount. When present, prefill the code,
  // open the modal, and auto-probe so the deep-link case behaves the same
  // as manual entry (public → no password field, private → password field
  // appears after probe resolves).
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const joinCode = params.get("join");
      if (joinCode) {
        const code = String(joinCode).toUpperCase();
        setJoinCodeInput(code);
        duel.setJoinModalOpen(true);
        // Fire-and-forget — runJoinProbe drives joinStage itself.
        runJoinProbe(code);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh lobby on mount and when returning to lobby
  useEffect(() => {
    if (duel.screen === "lobby" && isConnected) {
      duel.refreshLobby();
    }
  }, [duel.screen, isConnected]);

  // Prefetch usernames for both participants so we never have to fall back
  // to a truncated address once the room is populated.
  useEffect(() => {
    const addresses = [duel.room?.creator, duel.room?.joiner, duel.opponent].filter(Boolean);
    if (addresses.length > 0) profile.prefetch(addresses);
  }, [duel.room?.creator, duel.room?.joiner, duel.opponent, profile]);

  const opponentUsername = duel.opponent ? profile.usernameFor(duel.opponent) : null;

  // Prime the AudioContext on the first user gesture anywhere on the page.
  // Chromium won't play sound until a user gesture unlocks the context, so
  // we do it once here to make sure poll-driven cues (my-turn splash,
  // opponent joined, goals) can play without needing the user to click a
  // specific sound-triggering button first.
  useEffect(() => unlockOnFirstGesture(), []);

  // "Your turn!" splash — fires the first time isMyTurn flips true after
  // sitting on the opponent's turn. Auto-hides after ~1.4s so it doesn't
  // block the pitch. Only shows on the draft screen to avoid flashing over
  // the ready / match phases where isMyTurn also briefly toggles.
  const [showTurnSplash, setShowTurnSplash] = useState(false);
  const prevIsMyTurnRef = useRef(false);
  useEffect(() => {
    const wasMyTurn = prevIsMyTurnRef.current;
    prevIsMyTurnRef.current = duel.isMyTurn;
    if (duel.screen !== "draft") return;
    if (!wasMyTurn && duel.isMyTurn) {
      setShowTurnSplash(true);
      playSound("myTurn");
      const t = setTimeout(() => setShowTurnSplash(false), 1400);
      return () => clearTimeout(t);
    }
    if (wasMyTurn && !duel.isMyTurn) {
      // Turn passed to the opponent — softer descending cue.
      playSound("opponentTurn");
    }
  }, [duel.isMyTurn, duel.screen]);

  // Opponent joined the room — chirp when we cross into the ready screen
  // for the first time (i.e., we were previously in the waiting screen).
  const prevScreenRef = useRef(null);
  useEffect(() => {
    const prev = prevScreenRef.current;
    prevScreenRef.current = duel.screen;
    if (prev === "waiting" && duel.screen === "ready") {
      playSound("opponentJoined");
    }
  }, [duel.screen]);

  // Watch slot fill counts to play a click-y "pick landed" sound on each
  // increment. The ref-based baseline means the very first hydration
  // (which may bring several picks in one batch after a reconnect)
  // doesn't blast a machine-gun of sounds.
  const prevMyFilledRef = useRef(null);
  const prevOppFilledRef = useRef(null);
  useEffect(() => {
    const filled = duel.mySlots.filter((s) => s.player).length;
    if (prevMyFilledRef.current == null) {
      prevMyFilledRef.current = filled;
      return;
    }
    if (filled === prevMyFilledRef.current + 1) {
      playSound("pickPlaced");
    }
    prevMyFilledRef.current = filled;
  }, [duel.mySlots]);

  useEffect(() => {
    const filled = duel.opponentSlots.filter((s) => s.player).length;
    if (prevOppFilledRef.current == null) {
      prevOppFilledRef.current = filled;
      return;
    }
    if (filled === prevOppFilledRef.current + 1) {
      playSound("opponentPicked");
    }
    prevOppFilledRef.current = filled;
  }, [duel.opponentSlots]);

  // Reset the fill-count baselines on lobby / new duel so subsequent picks
  // in a fresh room fire sounds correctly (rather than being silenced by a
  // stale baseline left over from the last match).
  useEffect(() => {
    if (duel.screen === "lobby" || duel.screen === "waiting") {
      prevMyFilledRef.current = null;
      prevOppFilledRef.current = null;
    }
  }, [duel.screen]);

  // Kick off the head-to-head simulation as soon as we enter the match
  // screen. The server is idempotent — repeated calls return the stored
  // scoreline rather than re-rolling it.
  const [simulateError, setSimulateError] = useState(null);
  const runSimulate = useCallback(async () => {
    setSimulateError(null);
    const r = await duel.simulateMatch();
    if (r?.error) setSimulateError(r.error);
  }, [duel]);
  useEffect(() => {
    if (duel.screen !== "match") return;
    if (duel.matchResult) return;
    runSimulate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duel.screen, duel.matchResult]);

  // ── Toast system ────────────────────────────────────────────────────────
  const showToast = useCallback((msg, type = "info") => {
    if (type === "error" && typeof msg === "string") {
      if (msg.includes("ACTION_REJECTED") || msg.includes("user rejected")) msg = "Transaction cancelled";
      else if (msg.includes("insufficient funds")) msg = "Insufficient funds";
      else if (msg.length > 80) msg = msg.substring(0, 77) + "...";
    }
    if (type === "error") playSound("error");
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  // ── Create room handler ─────────────────────────────────────────────────
  // No on-chain interaction here. The stake is escrowed later, once BOTH
  // players are in the room and hit "Ready".
  const handleCreate = async () => {
    const stake = parseFloat(stakeInput);
    if (isNaN(stake) || stake < 0.1) {
      showToast("Minimum stake is 0.1 MON", "error");
      return;
    }
    if (isPrivate && passwordInput.length < 4) {
      showToast("Password must be at least 4 characters", "error");
      return;
    }

    const result = await duel.createRoom({
      stake: String(stake),
      isPrivate,
      password: isPrivate ? passwordInput : null,
    });
    if (result.error) {
      showToast(result.error, "error");
    } else {
      showToast("Room created! Share the code with your friend.", "success");
    }
  };

  // ── Join room handlers ──────────────────────────────────────────────────
  // Two-step: the user edits the code (which triggers an auto-probe so the
  // modal transitions to the right stage) and then clicks Join Duel. On
  // click, we either submit directly (public room) or submit with the
  // entered password (private room). Any probe failure surfaces inline —
  // never as a password fallback.

  // Reset the join modal's staged state. Called on modal close and any
  // code edit. `joinCodeInput` is intentionally NOT cleared on close so
  // the field survives a stray click on the overlay.
  const resetJoinModalState = useCallback(() => {
    setJoinStage("idle");
    setJoinProbeError(null);
    setProbedRoom(null);
    setJoinPasswordInput("");
    // Invalidate any in-flight probe so its late response can't move us
    // out of "idle" after the user has moved on.
    joinProbeSeqRef.current += 1;
  }, []);

  const handleJoinModalClose = useCallback(() => {
    duel.setJoinModalOpen(false);
    resetJoinModalState();
  }, [duel, resetJoinModalState]);

  // Code input onChange — reset staged state and fire a fresh probe. The
  // reset happens synchronously (so the password input disappears the
  // instant the code changes) and the probe fills it back in once the
  // room's privacy status is known.
  const handleJoinCodeChange = useCallback((e) => {
    const val = String(e?.target?.value ?? "").toUpperCase();
    setJoinCodeInput(val);
    setJoinPasswordInput("");
    setJoinProbeError(null);
    setProbedRoom(null);
    setJoinStage("idle");
    if (val.trim()) {
      // Fire-and-forget; runJoinProbe drives the stage from the result.
      runJoinProbe(val);
    } else {
      // Empty — bump the seq so any in-flight probe is dropped.
      joinProbeSeqRef.current += 1;
    }
  }, [runJoinProbe]);

  // Join Duel button click. Behavior depends on `joinStage`:
  //   awaiting-password + matching probed private room → submit with password
  //   idle + matching probed public room              → submit with no password
  //   not-found / error                                → retry the probe
  //   anything else                                    → probe first, then submit if public
  const handleJoinSubmit = useCallback(async () => {
    const code = joinCodeInput.trim().toUpperCase();
    if (!code) {
      showToast("Enter a room code", "error");
      return;
    }
    if (duel.busy || joinStage === "probing") return;

    // Private-room confirmation.
    if (
      joinStage === "awaiting-password" &&
      probedRoom &&
      probedRoom.room_code === code &&
      probedRoom.is_private
    ) {
      const result = await duel.joinRoom(code, joinPasswordInput || null);
      if (result.error) showToast(result.error, "error");
      else showToast("Joined room!", "success");
      return;
    }

    // Public-room submit — we've already probed and know it's public.
    if (
      probedRoom &&
      probedRoom.room_code === code &&
      probedRoom.is_private === false
    ) {
      const result = await duel.joinRoom(code, null);
      if (result.error) showToast(result.error, "error");
      else showToast("Joined room!", "success");
      return;
    }

    // Otherwise (idle without a matching probe, or retry from not-found /
    // error), run a fresh probe. If it comes back public, submit directly;
    // if it's private, the stage moves to "awaiting-password" and the user
    // enters the password on the next click; not-found / error stay in
    // their respective stages with no password fallback.
    const probeResult = await runJoinProbe(code);
    if (probeResult.status === "public" && probeResult.room) {
      const result = await duel.joinRoom(code, null);
      if (result.error) showToast(result.error, "error");
      else showToast("Joined room!", "success");
    }
  }, [
    duel,
    joinCodeInput,
    joinPasswordInput,
    joinStage,
    probedRoom,
    runJoinProbe,
    showToast,
  ]);

  // ── Join from lobby ─────────────────────────────────────────────────────
  const handleJoinFromLobby = async (room) => {
    const result = await duel.joinRoom(room.room_code);
    if (result.error) {
      showToast(result.error, "error");
    } else {
      showToast("Joined room!", "success");
    }
  };

  // ── Ready handler — this is where stake is asked for ─────────────────────
  // The escrow contract enforces ordering: the creator must call createDuel
  // before the joiner can call joinDuel. So joiners see a disabled button
  // until the creator has staked (see mustWaitForCreator in the ready screen).
  //
  // Steps: escrow on-chain → open session (if needed) → POST /ready.
  const handleReady = useCallback(async () => {
    if (!contract.isAvailable()) {
      showToast("Wallet not ready — reconnect and try again", "error");
      return;
    }

    // Extra guard for the joiner: if the creator hasn't staked yet on-chain,
    // joinDuel will revert. Surface a clear message instead of a raw error.
    if (!duel.isCreator && !duel.room?.creator_ready) {
      showToast("Waiting for the creator to stake first.", "info");
      return;
    }

    const result = await duel.readyUp({
      escrowAsCreator: (duelId, stakeMon) => contract.createDuel(duelId, stakeMon),
      escrowAsJoiner: (duelId) => contract.joinDuel(duelId),
      formatStake: weiToMon,
    });

    if (result?.error) {
      showToast(result.error, "error");
    }
  }, [contract, duel, showToast]);

  // ── Roll handler ────────────────────────────────────────────────────────
  const handleRoll = async () => {
    if (duel.busy || !duel.isMyTurn) return;
    playSound("roll");
    try {
      const payFn = contract.isAvailable() ? contract.payForRoll : null;
      await duel.roll("full", payFn);
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const handleReroll = async (mode) => {
    if (duel.busy || !duel.isMyTurn) return;
    playSound("reroll");
    try {
      const payFn = contract.isAvailable() ? contract.payForRoll : null;
      await duel.roll(mode, payFn);
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  // ── Player/slot click handlers ──────────────────────────────────────────
  const handlePlayerClick = (player) => {
    // Selecting a roll player and holding a slot for swap are mutually
    // exclusive modes — starting one cancels the other.
    setSwapFromIdx(null);
    if (duel.selectedPlayer?.id === player.id) {
      duel.setSelectedPlayer(null);
    } else {
      duel.setSelectedPlayer(player);
    }
  };

  const handleSlotClick = async (idx) => {
    const slot = duel.mySlots[idx];

    // Path A: user has a player picked from the current roll — this is a
    // brand-new pick placement. Keeps the original semantics.
    if (duel.selectedPlayer) {
      if (!slot.player && canPlayerFillSlot(duel.selectedPlayer, slot.pos)) {
        duel.pickPlayer(duel.selectedPlayer, idx);
      } else if (slot.player) {
        showToast("Slot occupied", "error");
      } else {
        showToast(`${duel.selectedPlayer.name} can't play ${slot.pos}`, "error");
      }
      return;
    }

    // Path B: swap-in-progress — this click is the destination. Fire the
    // rearrange call. Server does the real position compatibility check
    // against wc_players; we just do a client-side hint first for the
    // "swap two filled slots" case so we can bail out with a nicer toast.
    if (swapFromIdx != null) {
      if (swapFromIdx === idx) {
        // Clicked the same slot twice — treat as a cancel.
        setSwapFromIdx(null);
        return;
      }
      const source = duel.mySlots[swapFromIdx];
      if (!source?.player) {
        setSwapFromIdx(null);
        return;
      }
      // Position validation is handled server-side against the full positions
      // list from wc_players. The client only has the primary position after
      // hydration so we skip the client gate to avoid false negatives.
      const from = swapFromIdx;
      setSwapFromIdx(null);
      playSound("swap");
      const r = await duel.rearrangeSlots(from, idx);
      if (r?.error) showToast(r.error, "error");
      return;
    }

    // Path C: neutral — user just clicked a filled slot. Start a swap.
    if (slot.player) {
      setSwapFromIdx(idx);
    }
  };

  // ── Copy to clipboard ───────────────────────────────────────────────────
  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text);
    showToast(`${label} copied!`, "success");
  };

  const myStats = duel.getMyStats();
  const opStats = duel.getOpponentStats();
  const allPos = [...new Set(duel.squad.flatMap((p) => p.positions || []))].sort();

  return (
    <main className="duel-shell">
      <div className="game-card">
        <WalletGate isConnected={isConnected}>
          {/* ── Lobby Screen ─────────────────────────────────────────────── */}
          {duel.screen === "lobby" && (
            <section className="screen" style={{ display: "flex" }}>
              <div className="lobby-full">
                <div className="lobby-header">
                  <h2 className="lobby-title">1v1 Draft Duels</h2>
                  <div className="lobby-header-actions">
                    <button 
                      className="btn-lobby-action btn-lobby-action--create"
                      onClick={() => duel.setCreateModalOpen(true)}
                    >
                      + Create Duel
                    </button>
                    <button 
                      className="btn-lobby-action btn-lobby-action--join"
                      onClick={() => duel.setJoinModalOpen(true)}
                    >
                      Join Room
                    </button>
                    <button 
                      className="btn-refresh-lobby"
                      onClick={duel.refreshLobby}
                      disabled={duel.lobbyLoading}
                    >
                      {duel.lobbyLoading ? "..." : "Refresh ↺"}
                    </button>
                  </div>
                </div>

                <div className="challenges-list">
                  {duel.challenges.length === 0 ? (
                    <div className="challenges-empty">
                      No active challenges. Create one to get started!
                    </div>
                  ) : (
                    duel.challenges.map((room) => (
                      <div key={room.id} className="challenge-card">
                        <div className="challenge-info">
                          <span className="challenge-creator">
                            {room.creator_username || `${room.creator.slice(0, 6)}...${room.creator.slice(-4)}`}
                          </span>
                          <span className="challenge-stake">{weiToMon(room.stake)} MON</span>
                        </div>
                        <button 
                          className="btn-join-challenge"
                          onClick={() => handleJoinFromLobby(room)}
                          disabled={duel.busy}
                        >
                          Join
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Create Modal */}
              {duel.createModalOpen && (
                <div className="duel-modal-overlay" onClick={() => duel.setCreateModalOpen(false)}>
                  <div className="duel-modal" onClick={(e) => e.stopPropagation()}>
                    <div className="duel-modal-header">
                      <span className="duel-modal-title">Create a Duel</span>
                      <button className="duel-modal-close" onClick={() => duel.setCreateModalOpen(false)}>✕</button>
                    </div>
                    <div className="duel-modal-body">
                      <div className="create-duel-inputs">
                        <input
                          type="number"
                          placeholder="Stake amount (e.g. 0.5)"
                          step="0.1"
                          min="0.1"
                          value={stakeInput}
                          onChange={(e) => setStakeInput(e.target.value)}
                        />
                        <span className="stake-mon-label">MON</span>
                      </div>
                      <label className="duel-check">
                        <input
                          type="checkbox"
                          checked={isPrivate}
                          onChange={(e) => setIsPrivate(e.target.checked)}
                        />
                        <span>Private room (invite only)</span>
                      </label>
                      {isPrivate && (
                        <input
                          type="password"
                          className="duel-password-input"
                          placeholder="Room password (min 4 characters)"
                          value={passwordInput}
                          onChange={(e) => setPasswordInput(e.target.value)}
                        />
                      )}
                      <button 
                        className="btn-create-duel"
                        onClick={handleCreate}
                        disabled={duel.busy}
                      >
                        {duel.busy ? "Creating..." : "Create Challenge"}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Join Modal */}
              {duel.joinModalOpen && (
                <div className="duel-modal-overlay" onClick={handleJoinModalClose}>
                  <div className="duel-modal" onClick={(e) => e.stopPropagation()}>
                    <div className="duel-modal-header">
                      <span className="duel-modal-title">Join a Room</span>
                      <button className="duel-modal-close" onClick={handleJoinModalClose}>✕</button>
                    </div>
                    <div className="duel-modal-body">
                      <div className="create-duel-inputs">
                        <input
                          type="text"
                          placeholder="Room code (e.g. ABC23456)"
                          maxLength={10}
                          value={joinCodeInput}
                          onChange={handleJoinCodeChange}
                        />
                      </div>
                      {/* Password input renders ONLY when the probed room
                          is confirmed private. Public rooms and unresolved
                          codes never see this field. */}
                      {joinStage === "awaiting-password" && (
                        <input
                          type="password"
                          className="duel-password-input"
                          placeholder="Password (private rooms only)"
                          value={joinPasswordInput}
                          onChange={(e) => setJoinPasswordInput(e.target.value)}
                        />
                      )}
                      {joinStage === "not-found" && (
                        <p className="duel-join-status duel-join-status--error">
                          No room found with code {joinCodeInput}. Double-check the code and try again.
                        </p>
                      )}
                      {joinStage === "error" && (
                        <p className="duel-join-status duel-join-status--error">
                          {joinProbeError || "Something went wrong looking up that room. Try again."}
                        </p>
                      )}
                      <button 
                        className="btn-create-duel"
                        onClick={handleJoinSubmit}
                        disabled={duel.busy || joinStage === "probing"}
                      >
                        {duel.busy ? "Joining..." : "Join Duel"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* ── Waiting Screen ───────────────────────────────────────────── */}
          {duel.screen === "waiting" && (
            <section className="screen" style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
              <div className="waiting-panel">
                <div className="waiting-spinner" />
                <p className="waiting-title">Waiting for an opponent...</p>
                <p className="waiting-sub">Share these with a friend. Stakes are only escrowed once both of you are here and ready.</p>

                <div className="waiting-field">
                  <span className="waiting-label">Room code</span>
                  <div className="waiting-row">
                    <code className="waiting-code">{duel.roomCode || "--------"}</code>
                    <button 
                      type="button" 
                      className="waiting-copy"
                      onClick={() => copyToClipboard(duel.roomCode, "Room code")}
                    >
                      Copy
                    </button>
                  </div>
                </div>

                {duel.room?.is_private && (
                  <div className="waiting-field">
                    <span className="waiting-label">Password</span>
                    <div className="waiting-row">
                      <code className="waiting-code">{passwordInput}</code>
                      <button 
                        type="button" 
                        className="waiting-copy"
                        onClick={() => copyToClipboard(passwordInput, "Password")}
                      >
                        Copy
                      </button>
                    </div>
                    <p className="waiting-note">Private room — the opponent needs this to join.</p>
                  </div>
                )}

                <div className="waiting-field">
                  <span className="waiting-label">Invite link</span>
                  <div className="waiting-row">
                    <input
                      type="text"
                      className="waiting-link"
                      readOnly
                      value={typeof window !== "undefined" ? `${window.location.origin}/duel/${duel.roomCode}` : ""}
                    />
                    <button 
                      type="button" 
                      className="waiting-copy"
                      onClick={() => copyToClipboard(`${window.location.origin}/duel/${duel.roomCode}`, "Link")}
                    >
                      Copy
                    </button>
                  </div>
                </div>

                <button 
                  type="button" 
                  className="waiting-cancel"
                  onClick={duel.cancelRoom}
                  disabled={duel.busy}
                >
                  Cancel &amp; refund my stake
                </button>
              </div>
            </section>
          )}

          {/* ── Ready Screen ─────────────────────────────────────────────── */}
          {duel.screen === "ready" && (() => {
            const stakeMon = weiToMon(duel.room?.stake);
            const creatorReady = Boolean(duel.room?.creator_ready);
            const joinerReady = Boolean(duel.room?.joiner_ready);

            // The escrow contract enforces ordering: the joiner cannot call
            // joinDuel until the creator has called createDuel. So the joiner
            // must wait for the creator to stake first before their own
            // ready button becomes active.
            const isJoiner = !duel.isCreator;
            const mustWaitForCreator = isJoiner && !creatorReady && !duel.myReady;

            let statusMsg;
            if (duel.myReady && duel.opponentReady) {
              statusMsg = "Both ready — starting the draft…";
            } else if (duel.myReady) {
              statusMsg = "You're locked in. Waiting for your opponent to stake…";
            } else if (duel.opponentReady) {
              statusMsg = isJoiner
                ? "Opponent has staked. Your turn — match the stake to start."
                : "Opponent is ready. Stake now to start the draft.";
            } else if (mustWaitForCreator) {
              statusMsg = "Waiting for the creator to stake first…";
            } else {
              statusMsg = "Ready to stake? Both of you must confirm to start the draft.";
            }

            let buttonLabel;
            if (duel.myReady) buttonLabel = "Locked in ✓";
            else if (duel.busy) buttonLabel = "Confirming…";
            else if (mustWaitForCreator) buttonLabel = "Waiting for opponent…";
            else buttonLabel = `Stake ${stakeMon} MON & Ready ⚡`;

            return (
              <section className="screen" style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
                <div className="ready-panel">
                  <p className="ready-title">Opponent Joined!</p>
                  <p className="ready-sub">
                    Confirm to escrow <strong>{stakeMon} MON</strong> on-chain and start the draft.
                  </p>
                  <p className="ready-opponent">{statusMsg}</p>

                  {/* ── Formation Picker ────────────────────────────────── */}
                  {!duel.myReady && (
                    <div className="ready-formation-picker">
                      <p className="section-label">Choose Your Formation</p>
                      <p className="ready-formation-hint">Your formation affects tactical matchups during the match!</p>
                      <div className="btn-group ready-formation-grid">
                        {Object.keys(FORMATIONS).map((key) => (
                          <button
                            key={key}
                            className={`btn-formation ${duel.formation === key ? "active" : ""}`}
                            onClick={() => duel.setFormation(key)}
                            type="button"
                          >
                            {key}
                          </button>
                        ))}
                      </div>
                      <div className="ready-formation-preview">
                        <PitchView slots={duel.mySlots} onSlotClick={() => {}} className="ready-pitch-mini" />
                      </div>
                    </div>
                  )}

                  <div className="ready-status-grid">
                    <div className={`ready-status-pill ${duel.isCreator ? "ready-status-pill--me" : ""}`}>
                      <span className="ready-status-label">
                        {duel.isCreator ? "You (creator)" : "Creator"}
                      </span>
                      <span className="ready-status-name">
                        {profile.usernameFor(duel.room?.creator)}
                      </span>
                      <span className="ready-status-value">
                        {creatorReady ? "Staked ✓" : "Not staked"}
                      </span>
                    </div>
                    <div className={`ready-status-pill ${!duel.isCreator ? "ready-status-pill--me" : ""}`}>
                      <span className="ready-status-label">
                        {!duel.isCreator ? "You (joiner)" : "Joiner"}
                      </span>
                      <span className="ready-status-name">
                        {duel.room?.joiner ? profile.usernameFor(duel.room?.joiner) : "Waiting…"}
                      </span>
                      <span className="ready-status-value">
                        {joinerReady ? "Staked ✓" : "Not staked"}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="ready-btn"
                    onClick={handleReady}
                    disabled={duel.busy || duel.myReady || mustWaitForCreator}
                  >
                    {buttonLabel}
                  </button>
                </div>
              </section>
            );
          })()}

          {/* ── Draft Screen ─────────────────────────────────────────────── */}
          {duel.screen === "draft" && (
            <section className="screen" style={{ display: "flex", position: "relative" }}>
              {showTurnSplash && (
                <div className="turn-splash" aria-hidden="true">
                  <div className="turn-splash-text">YOUR TURN</div>
                </div>
              )}
              <aside className="duel-left">
                <TurnCountdown deadline={duel.room?.turn_deadline} isMyTurn={duel.isMyTurn}>
                  {({ secondsLeft, expired }) => {
                    // When my clock has expired, we no longer forfeit —
                    // the server just applies a rating penalty and lets
                    // me finish picking. Show "OVERTIME" instead of a
                    // frozen 0:00 so the UX is honest about what happens.
                    const showOvertime = expired && duel.isMyTurn;
                    const label = duel.isMyTurn
                      ? "YOUR TURN"
                      : `${opponentUsername || "OPPONENT"}'S TURN`;
                    return (
                      <div
                        className={`duel-turn-banner ${duel.isMyTurn ? "duel-turn-banner--active" : ""} ${expired ? "duel-turn-banner--expired" : ""}`}
                        role="status"
                        aria-live="polite"
                      >
                        <span>{label}</span>
                        {secondsLeft != null && (
                          <span className="duel-turn-clock">
                            {showOvertime
                              ? "OVERTIME"
                              : expired
                                ? "0:00"
                                : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`}
                          </span>
                        )}
                      </div>
                    );
                  }}
                </TurnCountdown>

                <div className="draft-console">
                  {duel.isMyTurn && duel.myPenaltyMaxRating != null && (
                    <div className="draft-penalty-note">
                      Timeout penalty — pick a player rated {duel.myPenaltyMaxRating} or lower to continue.
                    </div>
                  )}
                  {duel.isMyTurn && (
                    <>
                      <div className="rolls-left-row">
                        <span className="rolls-left-label">REROLLS: {REROLL_PRICE_MON} MON EACH</span>
                        <div className="roll-cost-badge">{REROLL_PRICE_MON} MON</div>
                      </div>
                      <div className="reroll-btns">
                        <button
                          className="btn-reroll"
                          onClick={() => handleReroll("nation")}
                          disabled={duel.busy || !duel.nationCode}
                        >
                          ↺ Nation
                        </button>
                        <button
                          className="btn-reroll"
                          onClick={() => handleReroll("year")}
                          disabled={duel.busy || !duel.nationCode}
                        >
                          ↺ Year
                        </button>
                      </div>
                    </>
                  )}

                  {(() => {
                    // Three modes:
                    //   (a) My turn, nothing rolled yet — show the Roll prompt.
                    //   (b) My turn, rolled — full interactive draft (existing UX).
                    //   (c) Opponent's turn — mirror their live roll read-only
                    //       if the server has one, otherwise a wait message.
                    const showOpponentRoll = !duel.isMyTurn && duel.opponentRoll;
                    const activeNationCode = duel.isMyTurn
                      ? duel.nationCode
                      : duel.opponentRoll?.nationCode;
                    const activeNationName = duel.isMyTurn
                      ? duel.nationName
                      : duel.opponentRoll?.nationName;
                    const activeYear = duel.isMyTurn ? duel.year : duel.opponentRoll?.year;

                    if (!activeNationCode) {
                      return (
                        <div className="draft-empty">
                          <div className="draft-empty-icon">🎲</div>
                          <h3 className="draft-empty-title">Draft Next Player</h3>
                          <p className="draft-empty-desc">
                            {duel.isMyTurn
                              ? "All rolls cost 0.01 MON."
                              : "Wait for your opponent to roll their wheel..."}
                          </p>
                          {duel.isMyTurn && (
                            <button
                              className="btn-play-roll"
                              onClick={handleRoll}
                              disabled={duel.busy}
                            >
                              {duel.busy ? "Rolling ⚽" : `Roll 🎲 (${REROLL_PRICE_MON} MON)`}
                            </button>
                          )}
                        </div>
                      );
                    }

                    // Squad list — filtered by position chip, deduped against
                    // whichever player list applies (mine when picking, the
                    // opponent's list when spectating).
                    const activeSquad = duel.isMyTurn
                      ? duel.filteredSquad
                      : (duel.opponentRoll?.squad ?? []).filter(
                          (p) => !duel.filterPos || p.positions?.includes(duel.filterPos)
                        );

                    return (
                      <div className={`draft-active ${showOpponentRoll ? "draft-active--spectator" : ""}`}>
                        <div className="drawn-card">
                          <div className="drawn-flag">
                            <img
                              src={getFlagUrl(activeNationCode)}
                              alt={activeNationName}
                              style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
                            />
                          </div>
                          <div className="drawn-info-wrap">
                            <span className="drawn-nation">{activeNationName}</span>
                            <span className="drawn-year">{activeYear}</span>
                          </div>
                        </div>

                        <div className="player-list-header">
                          {showOpponentRoll
                            ? `${opponentUsername || "Opponent"}'s options`
                            : "Select Player"}
                        </div>

                        <div className="pos-filters">
                          <button
                            className={`pos-chip ${!duel.filterPos ? "active" : ""}`}
                            onClick={() => duel.setFilterPos(null)}
                          >
                            All
                          </button>
                          {allPos.map((p) => (
                            <button
                              key={p}
                              className={`pos-chip ${duel.filterPos === p ? "active" : ""}`}
                              onClick={() => duel.setFilterPos(p)}
                            >
                              {p}
                            </button>
                          ))}
                        </div>

                        <div className="player-list-scroll">
                          {activeSquad.length === 0 ? (
                            <div className="player-empty">No players match this position</div>
                          ) : activeSquad.map((p) => {
                            const isElite = !!p.isLegendary;
                            const rc = isElite ? "#f0c040" : "var(--text2)";

                            if (showOpponentRoll) {
                              // Read-only row: no assignment state, no
                              // click handler. Purely informational.
                              return (
                                <div
                                  key={p.id}
                                  className="player-row player-row--spectator"
                                  style={{ borderLeft: `3px solid ${isElite ? "#f0c040" : "var(--border2)"}` }}
                                >
                                  <div className="player-row-left">
                                    <span className={`player-name ${isElite ? "player-name--elite" : ""}`}>{p.name}</span>
                                    <span className="player-pos-tags">{(p.positions || []).join(" / ")}</span>
                                  </div>
                                  <div className="player-rating-wrap">
                                    <div className="player-rating-bar">
                                      <div
                                        className="player-rating-bar-fill"
                                        style={{ width: `${p.rating}%`, background: isElite ? "#f0c040" : "var(--text3)" }}
                                      />
                                    </div>
                                    <span className="player-rating" style={{ color: rc }}>{p.rating}</span>
                                  </div>
                                </div>
                              );
                            }

                            const assigned = duel.assignedIds.has(p.id);
                            const nameUsed = !assigned && duel.assignedNames.has(p.name);
                            const hasSlot = duel.mySlots.some((s) => !s.player && canPlayerFillSlot(p, s.pos));
                            const isSelected = duel.selectedPlayer?.id === p.id;
                            const overPenalty =
                              duel.myPenaltyMaxRating != null &&
                              Number(p.rating) > duel.myPenaltyMaxRating;

                            let rowClass = "player-row";
                            if (assigned || nameUsed) rowClass += " player-row--assigned";
                            else if (!hasSlot || overPenalty) rowClass += " player-row--disabled";
                            else if (isSelected) rowClass += " player-row--selected";

                            return (
                              <div
                                key={p.id}
                                className={rowClass}
                                style={{ borderLeft: `3px solid ${isElite ? "#f0c040" : "var(--border2)"}` }}
                                onClick={() => !assigned && !nameUsed && hasSlot && !overPenalty && handlePlayerClick(p)}
                              >
                                <div className="player-row-left">
                                  <span className={`player-name ${isElite ? "player-name--elite" : ""}`}>{p.name}</span>
                                  <span className="player-pos-tags">{(p.positions || []).join(" / ")}</span>
                                </div>
                                <div className="player-rating-wrap">
                                  <div className="player-rating-bar">
                                    <div
                                      className="player-rating-bar-fill"
                                      style={{ width: `${p.rating}%`, background: isElite ? "#f0c040" : "var(--text3)" }}
                                    />
                                  </div>
                                  <span className="player-rating" style={{ color: rc }}>{p.rating}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                <div className="duel-actions-box">
                  <button
                    className="btn-cancel-draft"
                    onClick={() => {
                      // Mid-draft quit is a self-forfeit: the caller loses
                      // their stake to the opponent. A quick confirm keeps
                      // an accidental click from surrendering the pot.
                      const staked = BigInt(duel.room?.stake ?? "0") > 0n;
                      const msg = staked
                        ? "Quit this duel? Your opponent will win the pot."
                        : "Quit this duel?";
                      if (window.confirm(msg)) duel.cancelRoom();
                    }}
                    disabled={duel.busy}
                    style={{ flex: 1 }}
                  >
                    Quit Duel
                  </button>
                  <SoundToggle />
                </div>
              </aside>

              <div className="duel-main">
                <div className="duel-stats-banner">
                  <div className="duel-stat-col text-left">
                    <span className="duel-stat-label">YOUR SQUAD</span>
                    <span className="duel-stat-value" style={{ color: ratingColor(parseFloat(myStats.avg)) }}>
                      {myStats.avg}
                    </span>
                    <span className="duel-stat-sub">{myStats.assigned} / {myStats.total} picks</span>
                  </div>
                  <div className="duel-stat-divider">VS</div>
                  <div className="duel-stat-col text-right">
                    <span className="duel-stat-label">OPPONENT</span>
                    <span className="duel-stat-value" style={{ color: ratingColor(parseFloat(opStats.avg)) }}>
                      {opStats.avg}
                    </span>
                    <span className="duel-stat-sub">{opStats.assigned} / {opStats.total} picks</span>
                  </div>
                </div>

                <div className="duel-split-container">
                  <div className="duel-pitch-block">
                    <div className="duel-pitch-title">
                      Your Pitch
                      <span className="duel-formation-badge">{duel.formation}</span>
                    </div>
                    <PitchView
                      slots={duel.mySlots}
                      // When holding a filled slot for swap, treat that
                      // slot's player as the "highlight" so PitchView can
                      // light up compatible destinations.
                      highlightPlayer={
                        duel.selectedPlayer ||
                        (swapFromIdx != null ? duel.mySlots[swapFromIdx]?.player : null)
                      }
                      selectedSlotIdx={swapFromIdx}
                      swapSourcePos={
                        swapFromIdx != null ? duel.mySlots[swapFromIdx]?.pos : null
                      }
                      onSlotClick={handleSlotClick}
                    />
                  </div>
                  <div className="duel-pitch-block">
                    <div className="duel-pitch-title">
                      Opponent&apos;s Pitch
                      <span className="duel-formation-badge">{duel.room?.creator === duel.room?.joiner ? duel.formation : (duel.isCreator ? (duel.room?.joiner_formation || "4-3-3") : (duel.room?.creator_formation || "4-3-3"))}</span>
                    </div>
                    <PitchView
                      slots={duel.opponentSlots}
                      onSlotClick={() => {}}
                    />
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* ── Match/Result Screen ──────────────────────────────────────── */}
          {(duel.screen === "match" || duel.screen === "result") && (
            <DuelMatchScreen
              matchResult={duel.matchResult}
              room={duel.room}
              myAddress={address}
              myUsername={profile.username}
              opponentUsername={opponentUsername}
              onBackToLobby={duel.resetDuel}
              onRetry={runSimulate}
              error={simulateError}
              loading={!duel.matchResult && !simulateError}
            />
          )}
        </WalletGate>
      </div>

      {profile.showClaimModal && (
        <ProfileClaimModal
          onClaim={profile.claimUsername}
          onDismiss={profile.dismissModal}
          error={profile.claimError}
          busy={profile.claimBusy}
          setError={profile.setClaimError}
        />
      )}

      <Toast toasts={toasts} />
    </main>
  );
}
