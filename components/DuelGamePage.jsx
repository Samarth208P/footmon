"use client";

import { useState, useCallback, useEffect } from "react";
import { useAppKitAccount } from "@reown/appkit/react";
import { useContract } from "@/hooks/useContract";
import { useDuel } from "@/hooks/useDuel";
import { useProfile } from "@/hooks/useProfile";
import WalletGate from "./WalletGate";
import PitchView from "./PitchView";
import ProfileClaimModal from "./ProfileClaimModal";
import Toast from "./Toast";
import { getFlagUrl, canPlayerFillSlot, ratingColor, REROLL_PRICE_MON, FORMATIONS } from "@/lib/constants";

/** 32 random bytes → 0x-prefixed 64-char hex, matches the API's duelId regex. */
function randomDuelId() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return "0x" + Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
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
    if (!contract.isAvailable()) {
      showToast("Wallet not ready — reconnect and try again", "error");
      return;
    }

    // 1) Escrow the stake on-chain, using a fresh random duelId.
    const duelId = randomDuelId();
    try {
      await contract.createDuel(duelId, stake);
    } catch (err) {
      const rejected = err?.code === "ACTION_REJECTED" || /reject|denied/i.test(err?.message || "");
      showToast(rejected ? "Transaction cancelled" : (err.message || "Failed to escrow stake"), "error");
      return;
    }

    // 2) Register the room server-side with the duelId the contract now knows about.
    const result = await duel.createRoom({
      duelId,
      isPrivate,
      password: isPrivate ? passwordInput : null,
    });
    if (result.error) {
      showToast(result.error, "error");
    } else {
      showToast("Room created! Waiting for opponent...", "success");
    }
  };

  // ── Escrow on-chain then register the join server-side ──────────────────
  const escrowAndJoin = useCallback(async (code, password) => {
    if (!contract.isAvailable()) {
      showToast("Wallet not ready — reconnect and try again", "error");
      return;
    }
    const codeNorm = String(code || "").trim().toUpperCase();
    if (!codeNorm) {
      showToast("Enter a room code", "error");
      return;
    }

    // 1) Look up the room to get the on-chain duelId.
    const lookup = await duel.fetchRoomByCode(codeNorm);
    if (lookup.error) {
      showToast(lookup.error, "error");
      return;
    }
    const duelId = lookup.room?.duel_id;
    if (!duelId) {
      showToast("Room has no duelId — cannot join", "error");
      return;
    }

    // 2) Match the stake on-chain.
    try {
      await contract.joinDuel(duelId);
    } catch (err) {
      const rejected = err?.code === "ACTION_REJECTED" || /reject|denied/i.test(err?.message || "");
      showToast(rejected ? "Transaction cancelled" : (err.message || "Failed to escrow stake"), "error");
      return;
    }

    // 3) Register the join with the server.
    const result = await duel.joinRoom(codeNorm, password || null);
    if (result.error) {
      showToast(result.error, "error");
    } else {
      showToast("Joined room!", "success");
    }
  }, [contract, duel, showToast]);

  // ── Join room handler ───────────────────────────────────────────────────
  const handleJoin = async () => {
    await escrowAndJoin(joinCodeInput, joinPasswordInput);
  };

  // ── Join from lobby ─────────────────────────────────────────────────────
  const handleJoinFromLobby = async (room) => {
    await escrowAndJoin(room.room_code, null);
  };

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
                <p className="waiting-sub">Your stake is escrowed. Share these to invite someone.</p>

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
          {duel.screen === "ready" && (
            <section className="screen" style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
              <div className="ready-panel">
                <p className="ready-title">Opponent Joined!</p>
                <p className="ready-sub">Both stakes are escrowed on-chain. Confirm you&apos;re ready to start the draft.</p>
                <p className="ready-opponent">
                  {duel.opponentReady ? "Opponent is ready!" : "Waiting for opponent to ready up..."}
                </p>
                <button 
                  type="button" 
                  className="ready-btn"
                  onClick={duel.readyUp}
                  disabled={duel.busy || duel.myReady}
                >
                  {duel.myReady ? "Waiting..." : "Ready Up ⚡"}
                </button>
              </div>
            </section>
          )}

          {/* ── Draft Screen ─────────────────────────────────────────────── */}
          {duel.screen === "draft" && (
            <section className="screen" style={{ display: "flex" }}>
              <aside className="duel-left">
                <div className={`duel-turn-banner ${duel.isMyTurn ? "duel-turn-banner--active" : ""}`}>
                  <span>{duel.isMyTurn ? "YOUR TURN" : "OPPONENT'S TURN"}</span>
                </div>

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
            <section className="screen" style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
              <div className="result-panel">
                <h2>Match in Progress...</h2>
                <p>The match simulation is running.</p>
                <button onClick={duel.resetDuel}>Back to Lobby</button>
              </div>
            </section>
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
