"use client";

import { useState, useCallback, useEffect } from "react";
import { useAppKitAccount } from "@reown/appkit/react";
import { useContract } from "@/hooks/useContract";
import { useDuel } from "@/hooks/useDuel";
import { useProfile } from "@/hooks/useProfile";
import WalletGate from "./WalletGate";
import PitchView from "./PitchView";
import ProfileClaimModal from "./ProfileClaimModal";
import DuelMatchScreen from "./DuelMatchScreen";
import Toast from "./Toast";
import { getFlagUrl, canPlayerFillSlot, ratingColor, REROLL_PRICE_MON, FORMATIONS } from "@/lib/constants";

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
 * expired via the render prop.
 */
function TurnCountdown({ deadline, children }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [deadline]);

  const target = deadline ? Date.parse(deadline) : null;
  const secondsLeft = target ? Math.max(0, Math.ceil((target - now) / 1000)) : null;
  const expired = target != null && now > target;
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

  // Parse join code from URL on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const joinCode = params.get("join");
      if (joinCode) {
        setJoinCodeInput(joinCode);
        duel.setJoinModalOpen(true);
      }
    }
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

  // ── Join room handler ───────────────────────────────────────────────────
  // No on-chain interaction here either — just server-side join.
  const handleJoin = async () => {
    const code = joinCodeInput.trim().toUpperCase();
    if (!code) {
      showToast("Enter a room code", "error");
      return;
    }
    const result = await duel.joinRoom(code, joinPasswordInput || null);
    if (result.error) {
      showToast(result.error, "error");
    } else {
      showToast("Joined room!", "success");
    }
  };

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
    try {
      const payFn = duel.rolledThisTurn && contract.isAvailable() ? contract.payForRoll : null;
      await duel.roll("full", payFn);
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const handleReroll = async (mode) => {
    if (duel.busy || !duel.isMyTurn) return;
    try {
      const payFn = contract.isAvailable() ? contract.payForRoll : null;
      await duel.roll(mode, payFn);
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  // ── Player/slot click handlers ──────────────────────────────────────────
  const handlePlayerClick = (player) => {
    if (duel.selectedPlayer?.id === player.id) {
      duel.setSelectedPlayer(null);
    } else {
      duel.setSelectedPlayer(player);
    }
  };

  const handleSlotClick = (idx) => {
    const slot = duel.mySlots[idx];
    if (duel.selectedPlayer) {
      if (!slot.player && canPlayerFillSlot(duel.selectedPlayer, slot.pos)) {
        duel.pickPlayer(duel.selectedPlayer, idx);
      } else if (slot.player) {
        showToast("Slot occupied", "error");
      } else {
        showToast(`${duel.selectedPlayer.name} can't play ${slot.pos}`, "error");
      }
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
    <main className="min-h-screen">
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
                          <span className="challenge-stake">{room.stake} MON</span>
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
                <div className="duel-modal-overlay" onClick={() => duel.setJoinModalOpen(false)}>
                  <div className="duel-modal" onClick={(e) => e.stopPropagation()}>
                    <div className="duel-modal-header">
                      <span className="duel-modal-title">Join a Room</span>
                      <button className="duel-modal-close" onClick={() => duel.setJoinModalOpen(false)}>✕</button>
                    </div>
                    <div className="duel-modal-body">
                      <div className="create-duel-inputs">
                        <input
                          type="text"
                          placeholder="Room code (e.g. ABC23456)"
                          maxLength={10}
                          value={joinCodeInput}
                          onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                        />
                      </div>
                      <input
                        type="password"
                        className="duel-password-input"
                        placeholder="Password (private rooms only)"
                        value={joinPasswordInput}
                        onChange={(e) => setJoinPasswordInput(e.target.value)}
                      />
                      <button 
                        className="btn-create-duel"
                        onClick={handleJoin}
                        disabled={duel.busy}
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
            <section className="screen" style={{ display: "flex" }}>
              <aside className="duel-left">
                <TurnCountdown deadline={duel.room?.turn_deadline}>
                  {({ secondsLeft, expired }) => (
                    <div className={`duel-turn-banner ${duel.isMyTurn ? "duel-turn-banner--active" : ""} ${expired ? "duel-turn-banner--expired" : ""}`}>
                      <span>
                        {duel.isMyTurn
                          ? "YOUR TURN"
                          : `${opponentUsername || "OPPONENT"}'S TURN`}
                      </span>
                      {secondsLeft != null && (
                        <span className="duel-turn-clock">
                          {expired ? "0:00" : `0:${String(secondsLeft).padStart(2, "0")}`}
                        </span>
                      )}
                      {expired && !duel.isMyTurn && (
                        <button
                          type="button"
                          className="duel-forfeit-btn"
                          onClick={async () => {
                            const r = await duel.claimForfeit();
                            if (r?.error) showToast(r.error, "error");
                            else showToast("Opponent forfeited — you win by timeout!", "success");
                          }}
                        >
                          Claim Forfeit ⚡
                        </button>
                      )}
                    </div>
                  )}
                </TurnCountdown>

                <div className="draft-console">
                  <div className="rolls-left-row">
                    <span className="rolls-left-label">REROLLS: {REROLL_PRICE_MON} MON EACH</span>
                    <div className="roll-cost-badge">{REROLL_PRICE_MON} MON</div>
                  </div>
                  <div className="reroll-btns">
                    <button 
                      className="btn-reroll" 
                      onClick={() => handleReroll("nation")}
                      disabled={duel.busy || !duel.isMyTurn || !duel.nationCode}
                    >
                      ↺ Nation
                    </button>
                    <button 
                      className="btn-reroll"
                      onClick={() => handleReroll("year")}
                      disabled={duel.busy || !duel.isMyTurn || !duel.nationCode}
                    >
                      ↺ Year
                    </button>
                  </div>

                  {!duel.nationCode ? (
                    <div className="draft-empty">
                      <div className="draft-empty-icon">🎲</div>
                      <h3 className="draft-empty-title">Draft Next Player</h3>
                      <p className="draft-empty-desc">
                        {duel.isMyTurn 
                          ? "Roll to draw a nation and year. Rerolls cost 0.01 MON."
                          : "Wait for your opponent to finish their pick."}
                      </p>
                      <button 
                        className="btn-play-roll"
                        onClick={handleRoll}
                        disabled={duel.busy || !duel.isMyTurn}
                      >
                        {duel.busy ? "Rolling ⚽" : "Roll 🎲"}
                      </button>
                    </div>
                  ) : (
                    <div className="draft-active">
                      <div className="drawn-card">
                        <div className="drawn-flag">
                          <img 
                            src={getFlagUrl(duel.nationCode)} 
                            alt={duel.nationName} 
                            style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} 
                          />
                        </div>
                        <div className="drawn-info-wrap">
                          <span className="drawn-nation">{duel.nationName}</span>
                          <span className="drawn-year">{duel.year}</span>
                        </div>
                      </div>
                      
                      <div className="player-list-header">Select Player</div>
                      
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
                        {duel.filteredSquad.length === 0 ? (
                          <div className="player-empty">No players match this position</div>
                        ) : duel.filteredSquad.map((p) => {
                          const assigned = duel.assignedIds.has(p.id);
                          const nameUsed = !assigned && duel.assignedNames.has(p.name);
                          const hasSlot = duel.mySlots.some((s) => !s.player && canPlayerFillSlot(p, s.pos));
                          const isSelected = duel.selectedPlayer?.id === p.id;
                          const isElite = !!p.isLegendary;
                          const rc = isElite ? "#f0c040" : "var(--text2)";

                          let rowClass = "player-row";
                          if (assigned || nameUsed) rowClass += " player-row--assigned";
                          else if (!hasSlot) rowClass += " player-row--disabled";
                          else if (isSelected) rowClass += " player-row--selected";

                          return (
                            <div
                              key={p.id}
                              className={rowClass}
                              style={{ borderLeft: `3px solid ${isElite ? "#f0c040" : "var(--border2)"}` }}
                              onClick={() => !assigned && !nameUsed && hasSlot && handlePlayerClick(p)}
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
                  )}
                </div>

                <div className="duel-actions-box">
                  <button 
                    className="btn-cancel-draft"
                    onClick={duel.cancelRoom}
                    disabled={duel.busy}
                  >
                    Quit Duel
                  </button>
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
                    <div className="duel-pitch-title">Your Pitch</div>
                    <PitchView
                      slots={duel.mySlots}
                      highlightPlayer={duel.selectedPlayer}
                      onSlotClick={handleSlotClick}
                    />
                  </div>
                  <div className="duel-pitch-block">
                    <div className="duel-pitch-title">Opponent&apos;s Pitch</div>
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
