// js/leaderboard.js — three leaderboards behind one tabbed panel.
//
//   Tournament — solo 7-match runs, ranked wins → goal difference → rating
//   Duels      — 1v1 record, ranked wins → goal difference
//   Hourly     — on-chain squad ratings + prize pool for the current round
//
// Tournament and Duels are read from ranked Postgres views that already join
// usernames, so ordering here can never disagree with the database. Hourly comes
// straight from the contract.

const LeaderboardManager = (() => {
  const BOARDS = { TOURNAMENT: "tournament", DUEL: "duel", HOURLY: "hourly" };

  let countdownTimer = null;
  let lastContainer = null;
  let activeBoard = BOARDS.TOURNAMENT;

  // ── helpers ───────────────────────────────────────────────────────────────

  function rankMedal(rank) {
    if (rank === 1) return "🥇";
    if (rank === 2) return "🥈";
    if (rank === 3) return "🥉";
    return `#${rank}`;
  }

  function formatDiff(diff) {
    const n = Number(diff) || 0;
    return n > 0 ? `+${n}` : String(n);
  }

  function formatMon(wei) {
    try {
      return parseFloat(ethers.formatEther(String(wei ?? "0"))).toFixed(3);
    } catch {
      return "0.000";
    }
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  function contractAvailable() {
    return !!CONTRACT_ADDRESS;
  }

  function isMe(address, myAddr) {
    return Boolean(myAddr && address && address.toLowerCase() === myAddr.toLowerCase());
  }

  // ── shell ─────────────────────────────────────────────────────────────────

  /**
   * @param {HTMLElement} [containerEl] omitted on event-driven redraws, which is
   *        why the last container is remembered — calling this with nothing used
   *        to throw "Cannot set properties of undefined (setting 'innerHTML')".
   * @param {string} [board]
   */
  async function refresh(containerEl, board) {
    const el = containerEl || lastContainer;
    if (!el) return;
    lastContainer = el;
    if (board) activeBoard = board;

    el.innerHTML = `
      <div class="lb-tabs" role="tablist">
        ${tabButton(BOARDS.TOURNAMENT, "Tournament")}
        ${tabButton(BOARDS.DUEL, "Duels")}
        ${tabButton(BOARDS.HOURLY, "Hourly")}
      </div>
      <div class="lb-panel" id="lbPanel" role="tabpanel">
        <div class="lb-loading">Loading…</div>
      </div>
    `;

    el.querySelectorAll(".lb-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeBoard = btn.dataset.board;
        refresh(el);
      });
    });

    const panel = el.querySelector("#lbPanel");

    try {
      if (activeBoard === BOARDS.TOURNAMENT) await renderTournament(panel);
      else if (activeBoard === BOARDS.DUEL) await renderDuels(panel);
      else await renderHourly(panel);
    } catch (err) {
      panel.innerHTML = `<div class="lb-error">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }

  function tabButton(board, label) {
    const active = activeBoard === board;
    return `<button type="button" class="lb-tab${active ? " lb-tab--active" : ""}"
      data-board="${board}" role="tab" aria-selected="${active}">${label}</button>`;
  }

  function emptyState(message) {
    return `<div class="lb-empty">${escapeHtml(message)}</div>`;
  }

  // ── Tournament ────────────────────────────────────────────────────────────

  async function renderTournament(panel) {
    const res = await fetch("/api/leaderboard?board=tournament&limit=100", {
      cache: "no-store",
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Could not load the tournament board");

    const entries = json.tournament || [];
    if (entries.length === 0) {
      panel.innerHTML =
        `<p class="lb-blurb">Seven matches, one loss ends the run. Ranked by wins, then goal difference, then squad rating.</p>` +
        emptyState("No runs yet. Draft an XI and enter the tournament.");
      return;
    }

    const myAddr = WalletManager.getAddress();

    const rows = entries.map((e) => {
      const mine = isMe(e.address, myAddr);
      const champion = Number(e.wins) === 7;
      return `
        <tr class="lb-row${mine ? " lb-row--me" : ""}${champion ? " lb-row--champ" : ""}">
          <td class="lb-rank">${rankMedal(Number(e.rank))}</td>
          <td class="lb-player">
            <span class="lb-name">${escapeHtml(mine ? `${e.username} (you)` : e.username)}</span>
            ${champion ? `<span class="lb-badge">Champion</span>` : ""}
          </td>
          <td class="lb-wins"><span class="lb-wins-pill">${e.wins}/7</span></td>
          <td class="lb-gd" data-sign="${Number(e.goal_diff) >= 0 ? "pos" : "neg"}">${formatDiff(e.goal_diff)}</td>
          <td class="lb-goals">${e.goals_for}:${e.goals_against}</td>
          <td class="lb-score" style="color:${PitchRenderer.ratingColor(Number(e.team_rating))}">${Number(e.team_rating).toFixed(1)}</td>
        </tr>`;
    }).join("");

    panel.innerHTML = `
      <p class="lb-blurb">Seven matches, one loss ends the run. Ranked by wins, then goal difference, then squad rating.</p>
      <div class="lb-scroll">
        <table class="lb-table">
          <thead>
            <tr>
              <th>Rank</th><th>Player</th><th>Wins</th><th>GD</th><th>Goals</th><th>Rating</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // ── Duels ─────────────────────────────────────────────────────────────────

  async function renderDuels(panel) {
    const res = await fetch("/api/leaderboard?board=duel&limit=100", { cache: "no-store" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Could not load the duel board");

    const entries = json.duel || [];
    if (entries.length === 0) {
      panel.innerHTML =
        `<p class="lb-blurb">1v1 staked duels. Ranked by wins, then goal difference.</p>` +
        emptyState("No duels settled yet. Create a room and stake some MON.");
      return;
    }

    const myAddr = WalletManager.getAddress();

    const rows = entries.map((e) => {
      const mine = isMe(e.address, myAddr);
      return `
        <tr class="lb-row${mine ? " lb-row--me" : ""}">
          <td class="lb-rank">${rankMedal(Number(e.rank))}</td>
          <td class="lb-player">
            <span class="lb-name">${escapeHtml(mine ? `${e.username} (you)` : e.username)}</span>
          </td>
          <td class="lb-record">
            <span class="lb-w">${e.wins}W</span>
            <span class="lb-l">${e.losses}L</span>
            <span class="lb-d">${e.draws}D</span>
          </td>
          <td class="lb-gd" data-sign="${Number(e.goal_diff) >= 0 ? "pos" : "neg"}">${formatDiff(e.goal_diff)}</td>
          <td class="lb-goals">${e.goals_for}:${e.goals_against}</td>
          <td class="lb-won">${formatMon(e.mon_won)} MON</td>
        </tr>`;
    }).join("");

    panel.innerHTML = `
      <p class="lb-blurb">1v1 staked duels. Ranked by wins, then goal difference.</p>
      <div class="lb-scroll">
        <table class="lb-table">
          <thead>
            <tr>
              <th>Rank</th><th>Player</th><th>Record</th><th>GD</th><th>Goals</th><th>Won</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // ── Hourly (on-chain) ─────────────────────────────────────────────────────

  async function renderHourly(panel) {
    if (!contractAvailable()) {
      panel.innerHTML = emptyState("Contract not configured — set CONTRACT_ADDRESS in js/config.js.");
      return;
    }

    const [entries, prizePool, timeLeft, round, canDist] = await Promise.all([
      ContractManager.getLeaderboard(),
      ContractManager.getPrizePool(),
      ContractManager.getTimeUntilPayout(),
      ContractManager.getRoundNumber(),
      ContractManager.canDistribute(),
    ]);

    const myAddr = WalletManager.getAddress();
    const myPending = myAddr ? await ContractManager.getPendingClaim(myAddr) : 0n;

    const header = `
      <div class="lb-header">
        <div class="lb-pool">
          <span class="lb-pool-label">Prize Pool · Round ${round}</span>
          <span class="lb-pool-amount">${formatMon(prizePool)} <span class="mon-label">MON</span></span>
        </div>
        <div class="lb-timer-wrap">
          <span class="lb-timer-label">Next payout in</span>
          <span class="lb-timer" id="lbCountdown">${formatTime(Number(timeLeft))}</span>
        </div>
        ${canDist ? `<button class="btn-distribute" id="btnDistribute">Distribute Prize 🎉</button>` : ""}
        ${myPending > 0n ? `
          <div class="lb-claim-wrap">
            <span>You won <b>${formatMon(myPending)} MON</b> last round!</span>
            <button class="btn-claim" id="btnClaim">Claim Prize</button>
          </div>` : ""}
      </div>`;

    let body;
    if (entries.length === 0) {
      body = emptyState("No entries yet. Submit a squad rating to appear here.");
    } else {
      const top = entries.slice(0, 100);
      ProfileManager.prefetch(top.map((e) => e.player));

      const rows = top.map((e, i) => {
        const mine = isMe(e.player, myAddr);
        const iso2 = (ISO3_TO_2[e.nation] || e.nation.slice(0, 2)).toLowerCase();
        const name = mine ? "You" : ProfileManager.usernameFor(e.player);
        return `
          <tr class="lb-row${mine ? " lb-row--me" : ""}">
            <td class="lb-rank">${rankMedal(i + 1)}</td>
            <td class="lb-player"><span class="lb-name">${escapeHtml(name)}</span></td>
            <td class="lb-nation">
              <img class="lb-flag" src="flags/${iso2}.png" alt="${escapeHtml(e.nation)}" />
              ${escapeHtml(e.nation)} ${e.year}
            </td>
            <td class="lb-formation">${escapeHtml(e.formation)}</td>
            <td class="lb-score" style="color:${PitchRenderer.ratingColor(e.score)}">${e.score.toFixed(2)}</td>
          </tr>`;
      }).join("");

      body = `
        <div class="lb-scroll">
          <table class="lb-table">
            <thead>
              <tr><th>Rank</th><th>Player</th><th>Nation · Year</th><th>Formation</th><th>Rating</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }

    panel.innerHTML = header + body;

    panel.querySelector("#btnDistribute")?.addEventListener("click", async () => {
      try {
        showToast("Distributing prize… confirm in MetaMask", "info");
        await ContractManager.distributePrize();
        showToast("Prize distributed! 🎉", "success");
        refresh();
      } catch (e) { showToast(e.message, "error"); }
    });

    panel.querySelector("#btnClaim")?.addEventListener("click", async () => {
      try {
        showToast("Claiming prize… confirm in MetaMask", "info");
        await ContractManager.claimPrize();
        showToast("Prize claimed! 💰", "success");
        refresh();
      } catch (e) { showToast(e.message, "error"); }
    });

    startCountdown(Number(timeLeft));
  }

  // ── countdown ─────────────────────────────────────────────────────────────

  function formatTime(seconds) {
    if (seconds <= 0) return "00:00:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
  }

  function startCountdown(seconds) {
    if (countdownTimer) clearInterval(countdownTimer);
    let remaining = seconds;
    countdownTimer = setInterval(() => {
      remaining = Math.max(0, remaining - 1);
      const el = document.getElementById("lbCountdown");
      if (!el) {
        clearInterval(countdownTimer);
        return;
      }
      el.textContent = formatTime(remaining);
      if (remaining === 0) clearInterval(countdownTimer);
    }, 1000);
  }

  // Usernames arrive asynchronously; redraw once they do.
  document.addEventListener("profiles:updated", () => {
    const overlay = document.getElementById("leaderboardOverlay");
    if (overlay && overlay.classList.contains("open")) refresh();
  });

  return { refresh, BOARDS };
})();
