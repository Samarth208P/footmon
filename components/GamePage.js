"use client";

import { useState, useCallback } from "react";
import { useAppKitAccount } from "@reown/appkit/react";
import { useContract } from "@/hooks/useContract";
import { useGame } from "@/hooks/useGame";
import { useProfile } from "@/hooks/useProfile";
import WalletGate from "./WalletGate";
import FormationScreen from "./FormationScreen";
import PlayScreen from "./PlayScreen";
import MatchScreen from "./MatchScreen";
import LeaderboardOverlay from "./LeaderboardOverlay";
import ProfileClaimModal from "./ProfileClaimModal";
import Toast from "./Toast";
import { buildTournamentMessage, squadFingerprint } from "@/lib/tournament";

// Web Crypto SHA-256 → hex, to match the server's crypto.createHash("sha256").
async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// 16 random bytes → 32-char lowercase hex nonce (matches server's /^[0-9a-f]{32}$/i).
function randomNonce() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export default function GamePage() {
  const { address, isConnected } = useAppKitAccount();
  const contract = useContract();
  const game = useGame();
  const profile = useProfile();

  const [lbOpen, setLbOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [registering, setRegistering] = useState(false);

  // ── Toast system ────────────────────────────────────────────────────────
  const showToast = useCallback((msg, type = "info") => {
    // Simplify common wallet errors
    if (type === "error" && typeof msg === "string") {
      if (msg.includes("ACTION_REJECTED") || msg.includes("user rejected")) msg = "Transaction cancelled";
      else if (msg.includes("insufficient funds")) msg = "Insufficient funds";
      else if (msg.length > 80) msg = msg.substring(0, 77) + "...";
    }
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  // ── Tournament flow ─────────────────────────────────────────────────────
  //
  // Step 1 (handleEnterTournament):
  //   Player clicks "Enter Tournament" once the squad is complete. We POST
  //   /api/tournament/simulate (no auth, no recording) and hand the result
  //   to MatchScreen for playback. No wallet interaction happens yet.
  //
  // Step 2 (handleRegister):
  //   After MatchScreen finishes playing back a champion run, the summary
  //   panel offers a "Register on Leaderboard" button. That triggers this
  //   handler which builds the signature message (with the same seed the
  //   server used) and POSTs /api/tournament/runs to actually record it.
  //
  // If the user got knocked out, handleRegister is never called — the
  // summary just offers a "Try Again" button that resets the draft.
  const handleEnterTournament = useCallback(async () => {
    const score = game.getSubmitScore();
    if (!score) { showToast("Fill all 11 slots first", "error"); return; }
    if (!isConnected || !address) { showToast("Connect wallet first", "error"); return; }

    const players = game.slots
      .filter((s) => s.player)
      .map((s) => ({
        name: s.player.name,
        rating: s.player.rating,
        position: s.player.position || s.pos,
        positions: s.player.positions,
        // draftedNation/draftedYear are stamped at pick time and drive the
        // hidden chemistry system on the server. They're optional (older
        // squads won't have them) but forwarding them unlocks same-nation
        // and same-year chemistry bonuses.
        draftedNation: s.player.draftedNation ?? null,
        draftedYear: s.player.draftedYear ?? null,
      }));

    try {
      const res = await fetch("/api/tournament/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ players }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(json.error || "Simulation failed", "error");
        return;
      }
      // MatchScreen consumes { seed, run, champion, rounds }. It plays the
      // rounds back and surfaces the register button at the end.
      game.setMatchResult(json);
      game.setScreen("match");
    } catch (err) {
      console.error("[handleEnterTournament]", err);
      showToast(err.message || "Simulation failed", "error");
    }
  }, [game, isConnected, address, showToast]);

  // Called by MatchScreen when a champion clicks "Register on Leaderboard".
  const handleRegister = useCallback(async () => {
    if (registering) return;
    const matchResult = game.matchResult;
    const seed = matchResult?.seed;
    const run = matchResult?.run;
    if (!seed || !run?.champion) {
      showToast("Nothing to register", "error");
      return;
    }
    if (!isConnected || !address) {
      showToast("Connect wallet first", "error");
      return;
    }

    const provider = typeof window !== "undefined" ? window.__APPKIT_PROVIDER__ : null;
    if (!provider) {
      showToast("Wallet not ready — reconnect and try again", "error");
      return;
    }

    const players = game.slots
      .filter((s) => s.player)
      .map((s) => ({
        name: s.player.name,
        rating: s.player.rating,
        position: s.player.position || s.pos,
        positions: s.player.positions,
        // Same as the preview payload — feed the server the origin of each
        // pick so chemistry can be recomputed identically on the recorded run.
        draftedNation: s.player.draftedNation ?? null,
        draftedYear: s.player.draftedYear ?? null,
      }));

    const rep = game.slots.find((s) => s.player?.draftedNation);
    const nation = rep?.player?.draftedNation || null;
    const year = rep?.player?.draftedYear || null;

    setRegistering(true);
    try {
      const nonce = randomNonce();
      const issuedAt = new Date().toISOString();
      const squadHash = await sha256Hex(squadFingerprint(players));
      const message = buildTournamentMessage({ address, squadHash, seed, issuedAt, nonce });

      const signer = await provider.getSigner();
      let signature;
      try {
        signature = await signer.signMessage(message);
      } catch (err) {
        const rejected = err?.code === "ACTION_REJECTED" || /reject|denied/i.test(err?.message || "");
        showToast(rejected ? "Signature cancelled — run not recorded" : (err.message || "Signing failed"), "error");
        setRegistering(false);
        return;
      }

      const body = {
        address, players, seed, nation, year,
        formation: game.formation, issuedAt, nonce, signature,
      };

      const res = await fetch("/api/tournament/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        showToast(json.error || "Failed to record run", "error");
        setRegistering(false);
        return;
      }

      showToast("Champion run recorded on the leaderboard ✔", "success");

      // Also submit the rating to the on-chain daily board (best-effort).
      const score = run.teamRating ?? 0;
      if (contract.isAvailable() && nation && year) {
        try {
          await contract.submitScore(parseFloat(score.toFixed(2)), nation, year, game.formation);
          showToast(`Rating ${score.toFixed(1)} submitted to daily board ✔`, "success");
        } catch (err) {
          const rejected = err?.code === "ACTION_REJECTED" || /reject|denied/i.test(err?.message || "");
          showToast(rejected ? "Skipped daily board" : "Daily board failed — tournament saved.", "info");
        }
      }

      setLbOpen(true);
      game.resetDraft();
    } catch (err) {
      console.error("[handleRegister]", err);
      showToast(err.message || "Registration failed", "error");
    } finally {
      setRegistering(false);
    }
  }, [game, isConnected, address, contract, showToast, registering]);

  // Called by MatchScreen when the user closes the summary panel (either
  // "Try Again" after a loss, or "Skip and start over" after a champion run
  // they've chosen not to record).
  const handleFinishMatch = useCallback(() => {
    game.resetDraft();
  }, [game]);

  return (
    <main>
      <div className="game-card">
        <WalletGate isConnected={isConnected}>
          {game.screen === "formation" && (
            <FormationScreen
              game={game}
              onLeaderboard={() => setLbOpen(true)}
              prizePool={contract.prizePool}
            />
          )}
          {game.screen === "play" && (
            <PlayScreen
              game={game}
              contract={contract}
              isConnected={isConnected}
              onSubmit={handleEnterTournament}
              onLeaderboard={() => setLbOpen(true)}
              showToast={showToast}
            />
          )}
          {game.screen === "match" && game.matchResult && (
            <MatchScreen
              matchResult={game.matchResult}
              squadName={
                profile.username || (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Your Squad")
              }
              onRegister={handleRegister}
              onFinish={handleFinishMatch}
              registering={registering}
            />
          )}
        </WalletGate>
      </div>

      <LeaderboardOverlay
        open={lbOpen}
        onClose={() => setLbOpen(false)}
        contract={contract}
        address={address}
        usernameFor={profile.usernameFor}
      />

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
