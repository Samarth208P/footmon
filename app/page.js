import Link from "next/link";
import DailyPrizeBadge from "@/components/DailyPrizeBadge";
import LandingLeaderboard from "@/components/LandingLeaderboard";
import { CONTRACT_ADDRESS, MONAD_CHAIN, getFlagUrl } from "@/lib/constants";

export const metadata = {
  title: "FootMon — Draft the Greatest XI. Win MON.",
  description:
    "Roll for legendary World Cup squads, draft your dream 11, and win MON in daily tournaments and 1v1 staked duels on Monad Testnet.",
};

const ERAS = [
  { code: "BRA", label: "Brazil 1970" },
  { code: "ARG", label: "Argentina 1986" },
  { code: "GER", label: "Germany 1990" },
  { code: "FRA", label: "France 1998" },
  { code: "ITA", label: "Italy 2006" },
  { code: "ESP", label: "Spain 2010" },
  { code: "FRA", label: "France 2018" },
  { code: "ARG", label: "Argentina 2022" },
];

const FAQ = [
  {
    q: "What is MON, and how do I get testnet MON?",
    a: "MON is Monad's native token. FootMon runs on Monad Testnet (chainId 10143), so you can play with free testnet MON. Grab some from the official Monad faucet, connect your wallet, and you're in.",
  },
  {
    q: "How does the daily prize work?",
    a: "50% of every paid reroll (0.01 MON) flows into an on-chain prize pool. Every 24 hours the highest-rated squad — settled by the FootMon contract — wins the entire pot. Winners pull their prize with claimPrize(). Fully permissionless.",
  },
  {
    q: "How safe is my stake in a duel?",
    a: "Duel stakes sit in the contract's escrow. Winners are declared by a server-signed resolver, then pull payouts on-chain. If the resolver ever goes offline, anyone can call refundExpiredDuel() after the timeout and both players get their MON back.",
  },
  {
    q: "What if a duel ends in a draw?",
    a: "Draws refund both players their full stake, no rake. Cancelled duels (no one joined) refund the creator instantly.",
  },
  {
    q: "How are matches simulated?",
    a: "A deterministic on-server engine scores every match by squad rating, chemistry, formation and style. Same inputs always produce the same outcome — so results are reproducible and disputes have a paper trail.",
  },
];

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "FootMon",
  url: "https://footmon.app",
  description:
    "Roll for legendary World Cup squads, draft your dream 11, and win MON in daily tournaments and 1v1 staked duels on Monad.",
  applicationCategory: "GameApplication",
  operatingSystem: "Web",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    description: "Free to play with optional on-chain rolls (0.01 MON each)",
  },
  author: {
    "@type": "Organization",
    name: "FootMon",
    url: "https://footmon.app",
  },
  screenshot: "https://footmon.app/footmon.png",
};

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: {
      "@type": "Answer",
      text: item.a,
    },
  })),
};

export default function LandingPage() {
  return (
    <main className="landing">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <section className="landing-hero">
        <div className="hero-content">
          <div className="hero-badge">&#9917; LIVE ON MONAD TESTNET</div>
          <h1 className="hero-title">Draft the Greatest XI.<br />Win Real MON.</h1>
          <p className="hero-sub">
            Roll for legendary World Cup squads across five decades. Assemble your dream 11.
            Enter a 7-match tournament or stake MON in a live 1v1 draft duel — settled on-chain,
            paid out on-chain.
          </p>
          <div className="hero-actions">
            <Link href="/play" className="hero-btn hero-btn--primary">Play Solo · Free</Link>
            <Link href="/play/duel" className="hero-btn hero-btn--secondary">Stake in a Duel</Link>
          </div>
          <DailyPrizeBadge variant="hero" />
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

      <section className="landing-eras" aria-label="Supported World Cup eras">
        <p className="eras-title">Legendary squads from 1970 → 2026</p>
        <div className="eras-marquee">
          <div className="eras-track">
            {[...ERAS, ...ERAS, ...ERAS].map((era, i) => (
              <span key={`t1-${i}`} className="era-chip">
                <img
                  className="era-flag"
                  src={getFlagUrl(era.code)}
                  alt=""
                  width={18}
                  height={13}
                />
                {era.label}
              </span>
            ))}
          </div>
          <div className="eras-track" aria-hidden="true">
            {[...ERAS, ...ERAS, ...ERAS].map((era, i) => (
              <span key={`t2-${i}`} className="era-chip">
                <img
                  className="era-flag"
                  src={getFlagUrl(era.code)}
                  alt=""
                  width={18}
                  height={13}
                />
                {era.label}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-section" id="how">
        <h2 className="section-heading">How It Works</h2>
        <p className="section-sub">Four steps from wallet connect to prize payout.</p>
        <div className="how-grid">
          <div className="how-card">
            <div className="how-step">01</div>
            <div className="how-icon">&#127922;</div>
            <h3>Roll</h3>
            <p>Spin the wheel for a random nation and year. Get three free rolls per pick, then 0.01 MON each to reroll.</p>
          </div>
          <div className="how-card">
            <div className="how-step">02</div>
            <div className="how-icon">&#9917;</div>
            <h3>Draft</h3>
            <p>Choose the best player from every roll. Fill all 11 slots — position and chemistry drive your final rating.</p>
          </div>
          <div className="how-card">
            <div className="how-step">03</div>
            <div className="how-icon">&#127942;</div>
            <h3>Compete</h3>
            <p>Face a 7-match knockout gauntlet against AI squads, or stake MON in a real-time 1v1 draft duel.</p>
          </div>
          <div className="how-card">
            <div className="how-step">04</div>
            <div className="how-icon">&#128176;</div>
            <h3>Win</h3>
            <p>Top the daily leaderboard for the on-chain prize pool. Duel winners take 70% of the pot — funds settle instantly.</p>
          </div>
        </div>
      </section>

      <section className="landing-section landing-section--dark">
        <h2 className="section-heading">Two Ways to Play</h2>
        <p className="section-sub">Grind the daily leaderboard, or go head-to-head for the pot.</p>
        <div className="modes-grid">
          <div className="mode-card">
            <div className="mode-badge">SOLO</div>
            <h3>Tournament Mode</h3>
            <p>Draft your XI, then survive a 7-match knockout run against AI squads. One loss ends the run.</p>
            <ul className="mode-features">
              <li>Free to play — 3 free rolls per pick</li>
              <li>Daily on-chain prize pool for top squad</li>
              <li>Deterministic, reproducible match engine</li>
              <li>Submit your rating to the daily board</li>
            </ul>
            <Link href="/play" className="mode-btn">Play Solo &rarr;</Link>
          </div>
          <div className="mode-card mode-card--accent">
            <div className="mode-badge mode-badge--accent">1v1</div>
            <h3>Staked Duels</h3>
            <p>Challenge another player. Both stake MON. Alternate picking players. Best squad takes the pot.</p>
            <ul className="mode-features">
              <li>Real-time draft rooms with room codes</li>
              <li>Winner takes 70% of combined stake</li>
              <li>Escrow contract — stakes are safe</li>
              <li>Automatic refunds on timeout or draw</li>
            </ul>
            <Link href="/play/duel" className="mode-btn mode-btn--accent">Play Duel &rarr;</Link>
          </div>
        </div>
      </section>

      <LandingLeaderboard />

      <section className="landing-section" id="economics">
        <h2 className="section-heading">How the MON Flows</h2>
        <p className="section-sub">Every action on FootMon is on-chain. Here&apos;s where the value goes.</p>
        <div className="econ-grid">
          <div className="econ-card">
            <div className="econ-icon">&#127922;</div>
            <div className="econ-value">50%</div>
            <div className="econ-label">of every paid reroll feeds the daily prize pool</div>
          </div>
          <div className="econ-card">
            <div className="econ-icon">&#9200;</div>
            <div className="econ-value">24h</div>
            <div className="econ-label">payout interval — the highest-rated squad wins the pot</div>
          </div>
          <div className="econ-card">
            <div className="econ-icon">&#9876;</div>
            <div className="econ-value">70 / 30</div>
            <div className="econ-label">duel split — winner takes 70%, house rake 30%</div>
          </div>
          <div className="econ-card">
            <div className="econ-icon">&#128274;</div>
            <div className="econ-value">Pull</div>
            <div className="econ-label">payment pattern — winners claim on-chain, funds can&apos;t get stuck</div>
          </div>
        </div>
      </section>

      <section className="landing-section landing-section--dark" id="faq">
        <h2 className="section-heading">Frequently Asked</h2>
        <p className="section-sub">The short version of what&apos;s under the hood.</p>
        <div className="faq-list">
          {FAQ.map((item, i) => (
            <details key={i} className="faq-item">
              <summary className="faq-q">{item.q}</summary>
              <p className="faq-a">{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="landing-cta">
        <h2 className="landing-cta-title">Your squad&apos;s waiting.</h2>
        <p className="landing-cta-sub">Connect a wallet, roll your first nation, and see how far you can push it.</p>
        <div className="hero-actions">
          <Link href="/play" className="hero-btn hero-btn--primary">Start Playing</Link>
          <Link href="/play/duel" className="hero-btn hero-btn--secondary">Challenge a Friend</Link>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <div className="landing-footer-brand">
            <strong>FootMon</strong>
            <span className="landing-footer-tag">World Cup squad builder · on Monad</span>
          </div>
          <div className="landing-footer-links">
            <Link href="/play">Play Solo</Link>
            <Link href="/play/duel">1v1 Duel</Link>
            {CONTRACT_ADDRESS && (
              <a
                href={`${MONAD_CHAIN.blockExplorerUrls[0]}/address/${CONTRACT_ADDRESS}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                Contract &#8599;
              </a>
            )}
            <a
              href={MONAD_CHAIN.blockExplorerUrls[0]}
              target="_blank"
              rel="noreferrer noopener"
            >
              Monad Explorer &#8599;
            </a>
          </div>
        </div>
        <p className="landing-footer-note">
          Testnet only. MON has no real-world value. Play responsibly.
        </p>
      </footer>
    </main>
  );
}


