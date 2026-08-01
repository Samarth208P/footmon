"use client";

import { FORMATIONS } from "@/lib/constants";
import PitchView from "./PitchView";

/**
 * Formation selection screen — pick formation + style, then start rolling.
 */
export default function FormationScreen({ game, onStart, onLeaderboard, prizePool }) {
  const { formation, style, slots, setFormation, setStyle, busy } = game;

  const handleStart = async () => {
    game.setScreen("play");
    await game.roll("full");
  };

  return (
    <section className="screen" style={{ display: "flex" }}>
      <div className="mob-home-hero">
        <div className="mob-hero-badge">⚽ MONAD TESTNET</div>
        <h1 className="mob-hero-title">FootMon</h1>
        <p className="mob-hero-sub">Build your dream World Cup squad.<br />Compete on-chain. Win MON every day.</p>
        <div className="mob-hero-stats">
          <div className="mob-stat"><span className="mob-stat-val">11</span><span className="mob-stat-label">Picks per Squad</span></div>
          <div className="mob-stat-divider" />
          <div className="mob-stat"><span className="mob-stat-val">0.01</span><span className="mob-stat-label">MON / reroll</span></div>
          <div className="mob-stat-divider" />
          <div className="mob-stat">
            <span className="mob-stat-val">{prizePool ? parseFloat(prizePool).toFixed(3) : "—"}</span>
            <span className="mob-stat-label">Today&apos;s Prize (MON)</span>
          </div>
        </div>
      </div>

      <aside className="formation-panel">
        <div>
          <p className="section-label">Formation</p>
          <div className="btn-group">
            {Object.keys(FORMATIONS).map((key) => (
              <button
                key={key}
                className={`btn-formation ${formation === key ? "active" : ""}`}
                onClick={() => setFormation(key)}
              >
                {key}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="section-label">Style</p>
          <div className="btn-group">
            <button className={`btn-style ${style === "defensive" ? "active" : ""}`} onClick={() => setStyle("defensive")}>🛡 Defensive</button>
            <button className={`btn-style ${style === "balanced" ? "active" : ""}`} onClick={() => setStyle("balanced")}>⚖ Balanced</button>
            <button className={`btn-style ${style === "attacking" ? "active" : ""}`} onClick={() => setStyle("attacking")}>⚔ Attacking</button>
          </div>
        </div>

        <div className="formation-spacer" />

        <div className="formation-info">
          <p className="section-label">How it works</p>
          <p className="info-text">
            Pick a formation, roll for a nation &amp; year, build your 11.<br />
            Each pick gets 1 free roll · <span className="info-highlight">0.01 MON</span> per reroll.
          </p>
        </div>

        <div className="formation-actions">
          <button id="btnStart" onClick={handleStart} disabled={busy}>
            {busy ? "Rolling ⚽" : "Start Rolling 🎲"}
          </button>
          <button className="btn-home-leaderboard" onClick={onLeaderboard}>Leaderboard 🏆</button>
        </div>
      </aside>

      <div className="formation-pitch-wrap">
        <PitchView slots={slots} onSlotClick={() => {}} />
      </div>
    </section>
  );
}
