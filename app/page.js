import Script from "next/script";

const appMarkup = String.raw`
  <div class="game-card">
    <nav class="navbar">
      <div class="navbar-logo">
        <span class="logo-icon">⚽</span>
        <span>FootMon</span>
        <span class="logo-mon">MONAD</span>
      </div>
      <div class="navbar-nav">
        <button id="navSinglePlayer" class="nav-link active">Single Player</button>
        <button id="navDuelMode" class="nav-link">1v1 Duels</button>
      </div>
      <div class="navbar-right">
        <button id="btnConnect">🦊 Connect Wallet</button>
        <div id="walletBadge"></div>
      </div>
    </nav>

    <section id="screenFormation" class="screen">
      <div class="mob-home-hero">
        <div class="mob-hero-badge">⚽ MONAD TESTNET</div>
        <h1 class="mob-hero-title">FootMon</h1>
        <p class="mob-hero-sub">Build your dream World Cup squad.<br/>Compete on-chain. Win MON every hour.</p>
        <div class="mob-hero-stats">
          <div class="mob-stat"><span class="mob-stat-val">4</span><span class="mob-stat-label">Free Rolls</span></div>
          <div class="mob-stat-divider"></div>
          <div class="mob-stat"><span class="mob-stat-val">0.001</span><span class="mob-stat-label">MON / extra</span></div>
          <div class="mob-stat-divider"></div>
          <div class="mob-stat"><span class="mob-stat-val">50%</span><span class="mob-stat-label">Prize Pool</span></div>
        </div>
      </div>

      <aside class="formation-panel">
        <div>
          <p class="section-label">Formation</p>
          <div class="btn-group">
            <button class="btn-formation active" data-formation="4-3-3">4-3-3</button>
            <button class="btn-formation" data-formation="4-4-2">4-4-2</button>
            <button class="btn-formation" data-formation="4-2-3-1">4-2-3-1</button>
            <button class="btn-formation" data-formation="4-2-4">4-2-4</button>
            <button class="btn-formation" data-formation="3-5-2">3-5-2</button>
            <button class="btn-formation" data-formation="5-3-2">5-3-2</button>
            <button class="btn-formation" data-formation="4-5-1">4-5-1</button>
            <button class="btn-formation" data-formation="3-4-3">3-4-3</button>
          </div>
        </div>

        <div>
          <p class="section-label">Style</p>
          <div class="btn-group">
            <button class="btn-style" data-style="defensive">🛡 Defensive</button>
            <button class="btn-style active" data-style="balanced">⚖ Balanced</button>
            <button class="btn-style" data-style="attacking">⚔ Attacking</button>
          </div>
        </div>

        <div class="formation-spacer"></div>

        <div class="formation-info">
          <p class="section-label">How it works</p>
          <p class="info-text">
            Pick a formation, roll for a nation &amp; year, build your 11.<br/>
            4 free rolls · <span class="info-highlight">0.001 MON</span> per extra.
          </p>
        </div>

        <div class="formation-actions">
          <button id="btnStart">Start Rolling 🎲</button>
          <button id="btnHomeLeaderboard" class="btn-home-leaderboard">Leaderboard 🏆</button>
        </div>
      </aside>

      <div class="formation-pitch-wrap">
        <div class="pitch" id="pitchFormation"></div>
      </div>
    </section>

    <section id="screenPlay" class="screen" style="display:none">
      <div class="mobile-tabs" id="mobileTabs">
        <button class="mob-tab active" data-tab="draft" id="tabDraft">
          <span class="mob-tab-icon">🎲</span>
          <span class="mob-tab-label">Draft</span>
        </button>
        <button class="mob-tab" data-tab="pitch" id="tabPitch">
          <span class="mob-tab-icon">⚽</span>
          <span class="mob-tab-label">Pitch</span>
        </button>
        <button class="mob-tab" data-tab="stats" id="tabStats">
          <span class="mob-tab-icon">📊</span>
          <span class="mob-tab-label">Stats</span>
        </button>
      </div>

      <aside class="play-left">
        <div id="draftEmptyState" class="draft-empty">
          <div class="draft-empty-icon">🎲</div>
          <h3 class="draft-empty-title">Draft Next Player</h3>
          <div id="draftEmptyScore" class="draft-empty-score" style="display:none"></div>
          <p class="draft-empty-desc">Roll to draw a random World Cup nation &amp; year.</p>
          <div style="width: 100%; display: flex; flex-direction: column; gap: 8px;">
            <button id="btnPlayRoll" class="btn-play-roll">Roll 🎲</button>
            <button id="btnCancelDraft" class="btn-cancel-draft">Cancel &amp; Restart</button>
          </div>
        </div>

        <div id="draftActiveState" class="draft-active">
          <div class="drawn-card">
            <div id="drawnFlag" class="drawn-flag"></div>
            <div class="drawn-info-wrap">
              <div id="drawnNation" class="drawn-nation"></div>
              <div id="drawnYear" class="drawn-year"></div>
            </div>
          </div>

          <div class="reroll-section">
            <div class="reroll-header">
              <span class="rolls-left-label" id="rollsLeft"></span>
              <span class="roll-cost-badge" id="rollCostBadge">0.001 MON / roll</span>
            </div>
            <div class="reroll-btns">
              <button class="btn-reroll" id="btnNation">↺ Nation</button>
              <button class="btn-reroll" id="btnYear">↺ Year</button>
            </div>
          </div>

          <div class="player-list-header">Pick a Player</div>
          <div class="pos-filters" id="posFilters"></div>
          <div id="playerList"></div>
        </div>
      </aside>

      <div class="pitch-wrap">
        <div class="pitch" id="pitchPlay"></div>
      </div>

      <aside class="play-right">
        <div class="scorecard-header">
          <p class="scorecard-title">Team Stats</p>
          <div class="sc-avg-row">
            <span class="sc-avg" id="scAvg">—</span>
            <span class="sc-assigned" id="scAssigned">0 / 11</span>
          </div>
          <div class="sc-bars">
            <div class="sc-bar-row">
              <span class="sc-bar-label">ATK</span>
              <div class="sc-bar-track">
                <div class="sc-bar-fill" id="scAttack" style="width:0%"></div>
              </div>
            </div>
            <div class="sc-bar-row">
              <span class="sc-bar-label">DEF</span>
              <div class="sc-bar-track">
                <div class="sc-bar-fill" id="scDefense" style="width:0%"></div>
              </div>
            </div>
          </div>
        </div>

        <div id="scRows"></div>

        <div class="scorecard-actions">
          <button id="btnSubmit" disabled title="Fill all 11 slots to enter">Enter Tournament</button>
          <button id="btnLeaderboard">🏆 Leaderboard</button>
        </div>
      </aside>
    </section>

    <section id="screenDuelLobby" class="screen" style="display:none">
      <aside class="lobby-side">
        <h2 class="lobby-title">1v1 Draft Duels</h2>
        <p class="lobby-desc">Stake MON, alternate turns drafting, highest squad score wins the pot!</p>
        <div class="lobby-box">
          <p class="section-label">Create a Challenge</p>
          <div class="create-duel-inputs">
            <input type="number" id="inputDuelStake" placeholder="Stake amount (e.g. 0.5)" step="0.1" min="0.1" />
            <span class="stake-mon-label">MON</span>
          </div>

          <label class="duel-check">
            <input type="checkbox" id="inputDuelPrivate" />
            <span>Private room (invite only)</span>
          </label>
          <input
            type="password"
            id="inputDuelPassword"
            class="duel-password-input"
            placeholder="Room password (min 4 characters)"
            autocomplete="new-password"
            style="display:none"
          />

          <button id="btnCreateDuel" class="btn-create-duel">Create Challenge</button>
        </div>

        <div class="lobby-box">
          <p class="section-label">Join with a code</p>
          <div class="create-duel-inputs">
            <input type="text" id="inputJoinCode" placeholder="Room code (e.g. ABC23456)" maxlength="10" autocomplete="off" />
          </div>
          <input
            type="password"
            id="inputJoinPassword"
            class="duel-password-input"
            placeholder="Password (private rooms only)"
            autocomplete="off"
          />
          <button id="btnJoinByCode" class="btn-create-duel">Join Duel</button>
        </div>
      </aside>

      <div class="lobby-main">
        <div class="lobby-header">
          <span class="lobby-section-title">Open Challenges</span>
          <button id="btnRefreshLobby" class="btn-refresh-lobby">Refresh ↺</button>
        </div>
        <div id="duelLobbyStatus" class="duel-status" data-tone="info" style="display:none" role="status" aria-live="polite"></div>
        <div id="duelChallengesList" class="challenges-list">
          <div class="challenges-empty">No active challenges. Create one above!</div>
        </div>
      </div>
    </section>

    <section id="screenDuelPlay" class="screen" style="display:none">
      <aside class="duel-left">
        <div id="duelRoomStatus" class="duel-status" data-tone="info" style="display:none" role="status" aria-live="polite"></div>

        <div id="duelWaitingPanel" class="waiting-panel" style="display:none">
          <div class="waiting-spinner" aria-hidden="true"></div>
          <p class="waiting-title">Waiting for an opponent…</p>
          <p class="waiting-sub">Your stake is escrowed. Share these to invite someone.</p>

          <div class="waiting-field">
            <span class="waiting-label">Room code</span>
            <div class="waiting-row">
              <code id="waitingRoomCode" class="waiting-code">--------</code>
              <button type="button" class="waiting-copy" data-copy="code">Copy</button>
            </div>
          </div>

          <div class="waiting-field" id="waitingPasswordField" style="display:none">
            <span class="waiting-label">Password</span>
            <div class="waiting-row">
              <code id="waitingPassword" class="waiting-code"></code>
              <button type="button" class="waiting-copy" data-copy="password">Copy</button>
            </div>
            <p class="waiting-note">Private room — the opponent needs this to join.</p>
          </div>

          <div class="waiting-field">
            <span class="waiting-label">Invite link</span>
            <div class="waiting-row">
              <input type="text" id="waitingLink" class="waiting-link" readonly />
              <button type="button" class="waiting-copy" data-copy="link">Copy</button>
            </div>
            <p class="waiting-note" id="waitingLinkNote"></p>
          </div>

          <button type="button" id="btnCancelRoom" class="waiting-cancel">
            Cancel &amp; refund my stake
          </button>
        </div>

        <div id="duelTurnBanner" class="duel-turn-banner">
          <span id="duelTurnText">YOUR TURN</span>
        </div>

        <div id="duelDraftConsole" class="draft-console">
          <div class="rolls-left-row">
            <span class="rolls-left-label" id="duelRollsLeft">4 FREE ROLLS LEFT</span>
            <div class="roll-cost-badge" id="duelRollCostBadge">0.001 MON</div>
          </div>
          <div class="reroll-btns">
            <button id="btnDuelRerollNation" class="btn-reroll">↺ Nation</button>
            <button id="btnDuelRerollYear" class="btn-reroll">↺ Year</button>
          </div>

          <div id="duelDraftEmptyState" class="draft-empty">
            <div class="draft-empty-icon">🎲</div>
            <h3 class="draft-empty-title">Draft Next Player</h3>
            <p class="draft-empty-desc">Roll to draw a random World Cup nation &amp; year.</p>
            <div style="width: 100%; display: flex; flex-direction: column; gap: 8px;">
              <button id="btnDuelRoll" class="btn-play-roll">Roll 🎲</button>
            </div>
          </div>

          <div id="duelDraftActiveState" class="draft-active" style="display:none;">
            <div class="drawn-card">
              <div id="duelDrawnFlag" class="drawn-flag"></div>
              <div class="drawn-info-wrap">
                <span id="duelDrawnNation" class="drawn-nation">Brazil</span>
                <span id="duelDrawnYear" class="drawn-year">2002</span>
              </div>
            </div>
            <div class="player-list-header">Select Player</div>
            <div id="duelPlayerList"></div>
          </div>
        </div>

        <div class="duel-actions-box">
          <button id="btnDuelCancel" class="btn-cancel-draft">Quit Duel</button>
        </div>
      </aside>

      <div class="duel-main">
        <div class="duel-stats-banner">
          <div class="duel-stat-col text-left">
            <span class="duel-stat-label">YOUR SQUAD</span>
            <span class="duel-stat-value" id="duelMyAvg">0.0</span>
            <div class="duel-stat-minibar"><div id="duelMyAttackBar" style="width:0%"></div></div>
            <span class="duel-stat-sub">ATK: <b id="duelMyAttack">0</b> | DEF: <b id="duelMyDefense">0</b></span>
          </div>
          <div class="duel-stat-divider">VS</div>
          <div class="duel-stat-col text-right">
            <span class="duel-stat-label">OPPONENT SQUAD</span>
            <span class="duel-stat-value" id="duelOpAvg">0.0</span>
            <div class="duel-stat-minibar"><div id="duelOpAttackBar" style="width:0%"></div></div>
            <span class="duel-stat-sub">ATK: <b id="duelOpAttack">0</b> | DEF: <b id="duelOpDefense">0</b></span>
          </div>
        </div>

        <div class="duel-split-container">
          <div class="duel-pitch-block">
            <div class="duel-pitch-title">Your Pitch</div>
            <div class="pitch" id="pitchDuelPlayer"></div>
          </div>
          <div class="duel-pitch-block">
            <div class="duel-pitch-title">Opponent's Pitch</div>
            <div class="pitch" id="pitchDuelOpponent"></div>
          </div>
        </div>
      </div>
    </section>
  </div>

  <div id="leaderboardOverlay">
    <div class="lb-panel">
      <div class="lb-nav">
        <span class="lb-nav-title">🏆 Leaderboard · Hourly Prize</span>
        <button id="btnCloseLb" title="Close">✕</button>
      </div>
      <div id="lbBody"></div>
    </div>
  </div>

  <div id="customModalOverlay" class="custom-modal-overlay">
    <div class="custom-modal-panel">
      <div class="custom-modal-header">
        <span id="customModalTag" class="custom-modal-tag">⚽ FOOTMON DUELS</span>
        <button id="customModalClose" class="btn-close-modal">✕</button>
      </div>
      <div class="custom-modal-body">
        <div id="customModalIcon" class="custom-modal-icon">🏆</div>
        <h2 id="customModalTitle" class="custom-modal-title">Victory!</h2>
        <p id="customModalSubtitle" class="custom-modal-subtitle">You won the duel!</p>
        <div id="customModalBox" class="custom-modal-box"></div>
      </div>
      <div id="customModalFooter" class="custom-modal-footer"></div>
    </div>
  </div>

  <div id="toastWrap"></div>
`;

export default function HomePage() {
  return (
    <>
      <main className="min-h-screen">
        <div id="app" suppressHydrationWarning dangerouslySetInnerHTML={{ __html: appMarkup }} />
      </main>

      <Script
        src="https://cdnjs.cloudflare.com/ajax/libs/ethers/6.7.1/ethers.umd.min.js"
        strategy="beforeInteractive"
      />
      {/* Publishable key only — RLS-constrained, SELECT-only, safe in the browser. */}
      <Script
        id="footmon-supabase-config"
        strategy="beforeInteractive"
        dangerouslySetInnerHTML={{
          __html: `window.__FOOTMON_SUPABASE = ${JSON.stringify({
            url: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
            anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
          })};`,
        }}
      />
      <Script
        src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.111.0/dist/umd/supabase.js"
        strategy="beforeInteractive"
      />
      <Script src="/js/config.js" strategy="afterInteractive" />
      <Script src="/js/data.js" strategy="afterInteractive" />
      <Script src="/js/wallet.js" strategy="afterInteractive" />
      <Script src="/js/profile.js" strategy="afterInteractive" />
      <Script src="/js/duel-events.js" strategy="afterInteractive" />
      <Script src="/js/duel-screen.js" strategy="afterInteractive" />
      <Script src="/js/realtime.js" strategy="afterInteractive" />
      <Script src="/js/match-view.js" strategy="afterInteractive" />
      <Script src="/js/contract.js" strategy="afterInteractive" />
      <Script src="/js/duel-room.js" strategy="afterInteractive" />
      <Script src="/js/pitch.js" strategy="afterInteractive" />
      <Script src="/js/game.js" strategy="afterInteractive" />
      <Script src="/js/leaderboard.js" strategy="afterInteractive" />
      <Script src="/js/tournament.js" strategy="afterInteractive" />
      <Script src="/js/duel.js" strategy="afterInteractive" />
      <Script src="/js/main.js" strategy="afterInteractive" />
    </>
  );
}
