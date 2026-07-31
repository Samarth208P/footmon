// js/leaderboard.js — Leaderboard UI, prize pool, countdown timer

const LeaderboardManager = (() => {

  let countdownTimer = null;

  function shortAddr(addr) {
    return addr.slice(0, 6) + "…" + addr.slice(-4);
  }

  function rankMedal(rank) {
    if (rank === 1) return "🥇";
    if (rank === 2) return "🥈";
    if (rank === 3) return "🥉";
    return `#${rank}`;
  }

  function formatMON(bigint) {
    return parseFloat(ethers.formatEther(bigint)).toFixed(4) + " MON";
  }

  async function refresh(containerEl) {
    if (!contractAvailable()) {
      containerEl.innerHTML = `
        <div class="lb-notice">
          <p>Contract not deployed yet.</p>
          <p class="lb-notice-sub">See DEPLOY.md to deploy FootMon.sol on Monad Testnet.</p>
        </div>`;
      return;
    }

    containerEl.innerHTML = `<div class="lb-loading">Loading leaderboard…</div>`;

    try {
      const [entries, prizePool, timeLeft, round, canDist] = await Promise.all([
        ContractManager.getLeaderboard(),
        ContractManager.getPrizePool(),
        ContractManager.getTimeUntilPayout(),
        ContractManager.getRoundNumber(),
        ContractManager.canDistribute(),
      ]);

      const myAddr     = WalletManager.getAddress();
      const myPending  = myAddr ? await ContractManager.getPendingClaim(myAddr) : 0n;

      renderHeader(containerEl, prizePool, timeLeft, round, myPending, canDist);
      renderTable(containerEl, entries, myAddr);
      startCountdown(containerEl, Number(timeLeft));

    } catch (err) {
      containerEl.innerHTML = `<div class="lb-error">Failed to load: ${err.message}</div>`;
    }
  }

  function renderHeader(el, prizePool, timeLeft, round, myPending, canDist) {
    const prizeEth     = ethers.formatEther(prizePool);
    const prizeDisplay = parseFloat(prizeEth).toFixed(4);
    const pendingDisplay = parseFloat(ethers.formatEther(myPending)).toFixed(4);

    el.insertAdjacentHTML("beforeend", `
      <div class="lb-header">
        <div class="lb-pool">
          <span class="lb-pool-label">Prize Pool · Round ${round}</span>
          <span class="lb-pool-amount">${prizeDisplay} <span class="mon-label">MON</span></span>
        </div>
        <div class="lb-timer-wrap">
          <span class="lb-timer-label">Next payout in</span>
          <span class="lb-timer" id="lbCountdown">${formatTime(Number(timeLeft))}</span>
        </div>
        ${canDist ? `<button class="btn-distribute" id="btnDistribute">Distribute Prize 🎉</button>` : ""}
        ${myPending > 0n ? `
          <div class="lb-claim-wrap">
            <span>You won <b>${pendingDisplay} MON</b> last round!</span>
            <button class="btn-claim" id="btnClaim">Claim Prize</button>
          </div>` : ""}
      </div>
    `);

    document.getElementById("btnDistribute")?.addEventListener("click", async () => {
      try {
        showToast("Distributing prize… confirm in MetaMask", "info");
        await ContractManager.distributePrize();
        showToast("Prize distributed! 🎉", "success");
        refresh(el.parentElement?.querySelector(".lb-body") || el);
      } catch (e) { showToast(e.message, "error"); }
    });

    document.getElementById("btnClaim")?.addEventListener("click", async () => {
      try {
        showToast("Claiming prize… confirm in MetaMask", "info");
        await ContractManager.claimPrize();
        showToast("Prize claimed! 💰", "success");
        refresh(el.parentElement?.querySelector(".lb-body") || el);
      } catch (e) { showToast(e.message, "error"); }
    });
  }

  function renderTable(el, entries, myAddr) {
    if (entries.length === 0) {
      el.insertAdjacentHTML("beforeend", `
        <div class="lb-empty">No entries yet. Be the first to submit your score!</div>
      `);
      return;
    }

    const top100 = entries.slice(0, 100);

    // Resolve any names we do not have yet, then re-render when they arrive.
    ProfileManager.prefetch(top100.map((e) => e.player));

    const rows = top100.map((e, i) => {
      const isMe  = myAddr && e.player.toLowerCase() === myAddr.toLowerCase();
      const score = e.score.toFixed(2);
      const iso2  = (ISO3_TO_2[e.nation] || e.nation.slice(0, 2)).toLowerCase();
      const flagHtml = `<img src="flags/${iso2}.png" alt="${e.nation}" style="width:18px; height:12px; object-fit:cover; border-radius:1px; vertical-align:middle; margin-right:5px; box-shadow:0 1px 2px rgba(0,0,0,0.3);" />`;
      const date  = new Date(e.timestamp * 1000).toLocaleDateString();
      const name  = isMe ? "You" : ProfileManager.usernameFor(e.player);
      return `
        <tr class="lb-row ${isMe ? "lb-row--me" : ""}">
          <td class="lb-rank">${rankMedal(i + 1)}</td>
          <td class="lb-player">
            <span class="lb-addr">${name}</span>
          </td>
          <td class="lb-nation">${flagHtml} ${e.nation} ${e.year}</td>
          <td class="lb-formation">${e.formation}</td>
          <td class="lb-score" style="color:${PitchRenderer.ratingColor(e.score)}">${score}</td>
          <td class="lb-date">${date}</td>
        </tr>`;
    }).join("");

    el.insertAdjacentHTML("beforeend", `
      <table class="lb-table">
        <thead>
          <tr>
            <th>Rank</th><th>Player</th><th>Nation · Year</th><th>Formation</th><th>Avg</th><th>Date</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `);
  }

  function formatTime(seconds) {
    if (seconds <= 0) return "00:00:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return [h, m, s].map(v => String(v).padStart(2, "0")).join(":");
  }

  function startCountdown(el, seconds) {
    if (countdownTimer) clearInterval(countdownTimer);
    let remaining = seconds;
    countdownTimer = setInterval(() => {
      remaining = Math.max(0, remaining - 1);
      const el = document.getElementById("lbCountdown");
      if (el) el.textContent = formatTime(remaining);
      if (remaining === 0) clearInterval(countdownTimer);
    }, 1000);
  }

  function contractAvailable() {
    return !!CONTRACT_ADDRESS;
  }

  // Usernames arrive asynchronously; redraw once they do so the table never
  // sits showing shortened addresses.
  document.addEventListener("profiles:updated", () => {
    const overlay = document.getElementById("leaderboardOverlay");
    if (overlay && !overlay.hidden && overlay.style.display !== "none") refresh();
  });

  return { refresh };
})();
