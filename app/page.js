import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="landing">
      <section className="landing-hero">
        <div className="hero-content">
          <div className="hero-badge">&#9917; LIVE ON MONAD TESTNET</div>
          <h1 className="hero-title">Build Your Dream<br />World Cup Squad</h1>
          <p className="hero-sub">
            Roll for legendary footballers. Draft your XI. Compete in solo tournaments
            or stake MON in 1v1 duels. The beautiful game, on-chain.
          </p>
          <div className="hero-actions">
            <Link href="/play" className="hero-btn hero-btn--primary">Play Solo</Link>
            <Link href="/play/duel" className="hero-btn hero-btn--secondary">1v1 Duel</Link>
          </div>
          <div className="hero-stats-row">
            <div className="hero-stat">
              <span className="hero-stat-val">11</span>
              <span className="hero-stat-label">Players per Squad</span>
            </div>
            <div className="hero-stat-divider" />
            <div className="hero-stat">
              <span className="hero-stat-val">0.01</span>
              <span className="hero-stat-label">MON per Reroll</span>
            </div>
            <div className="hero-stat-divider" />
            <div className="hero-stat">
              <span className="hero-stat-val">7</span>
              <span className="hero-stat-label">Tournament Rounds</span>
            </div>
            <div className="hero-stat-divider" />
            <div className="hero-stat">
              <span className="hero-stat-val">70%</span>
              <span className="hero-stat-label">Duel Winner Payout</span>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-section" id="how">
        <h2 className="section-heading">How It Works</h2>
        <div className="how-grid">
          <div className="how-card">
            <div className="how-icon">&#127922;</div>
            <h3>Roll</h3>
            <p>Get a random World Cup nation and year. Discover legendary squads from 1970 to 2026.</p>
          </div>
          <div className="how-card">
            <div className="how-icon">&#9917;</div>
            <h3>Draft</h3>
            <p>Pick the best player from each roll to fill your 11. Position and chemistry matter.</p>
          </div>
          <div className="how-card">
            <div className="how-icon">&#127942;</div>
            <h3>Compete</h3>
            <p>Enter a 7-match knockout tournament or stake MON in a live 1v1 draft duel.</p>
          </div>
          <div className="how-card">
            <div className="how-icon">&#128176;</div>
            <h3>Win</h3>
            <p>Top the leaderboard for daily MON prizes. Duel winners take 70% of the staked pot.</p>
          </div>
        </div>
      </section>

      <section className="landing-section landing-section--dark">
        <h2 className="section-heading">Two Ways to Play</h2>
        <div className="modes-grid">
          <div className="mode-card">
            <div className="mode-badge">SOLO</div>
            <h3>Tournament Mode</h3>
            <p>Draft your squad, enter a 7-match gauntlet against AI. One loss ends your run.</p>
            <ul className="mode-features">
              <li>Free to play (rerolls cost 0.01 MON)</li>
              <li>Daily prize pool for top ratings</li>
              <li>Deterministic simulation</li>
            </ul>
            <Link href="/play" className="mode-btn">Play Solo</Link>
          </div>
          <div className="mode-card mode-card--accent">
            <div className="mode-badge mode-badge--accent">1v1</div>
            <h3>Staked Duels</h3>
            <p>Challenge another player. Both stake MON. Alternate picking players. Best squad wins.</p>
            <ul className="mode-features">
              <li>Real-time draft with voice chat</li>
              <li>Winner takes 70% of combined stake</li>
              <li>Escrow contract — funds are safe</li>
            </ul>
            <Link href="/play/duel" className="mode-btn mode-btn--accent">Play Duel</Link>
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <p>FootMon — Built on Monad Testnet</p>
      </footer>
    </main>
  );
}
