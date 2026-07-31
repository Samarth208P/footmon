// js/match-view.js — centre-screen match presentation.
//
// The match is already decided and stored server-side before this runs; this
// module only replays the recorded minute ticks. That is what makes the two
// players' screens agree: they are animating the same durable log, not each
// simulating locally.

const MatchView = (() => {
  /** 90 in-game minutes are paced into roughly this long. */
  const MATCH_DURATION_MS = 75000;
  const FULL_TIME = 90;

  let overlay = null;
  let timer = null;
  let onClaimHandler = null;

  function build() {
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.className = "match-overlay";
    overlay.hidden = true;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Duel match");
    overlay.innerHTML = `
      <div class="match-stage">
        <div class="match-teams">
          <div class="match-team match-team--home">
            <div class="match-team-name" id="mvHomeName">You</div>
            <ul class="match-lineup" id="mvHomeLineup"></ul>
          </div>

          <div class="match-centre">
            <div class="match-clock" id="mvClock" aria-live="off">0'</div>
            <div class="match-score" id="mvScore">0 – 0</div>
            <div class="match-phase" id="mvPhase" role="status" aria-live="polite">Kick off</div>
          </div>

          <div class="match-team match-team--away">
            <div class="match-team-name" id="mvAwayName">Opponent</div>
            <ul class="match-lineup" id="mvAwayLineup"></ul>
          </div>
        </div>

        <div class="match-feed" id="mvFeed" aria-live="polite"></div>

        <div class="match-result" id="mvResult" hidden>
          <div class="match-result-headline" id="mvResultHeadline"></div>
          <div class="match-result-detail" id="mvResultDetail"></div>
          <div class="match-result-actions">
            <button type="button" class="match-btn match-btn--primary" id="mvClaimBtn" hidden>
              Claim winnings
            </button>
            <button type="button" class="match-btn" id="mvCloseBtn">Back to lobby</button>
          </div>
          <div class="match-result-note" id="mvResultNote"></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector("#mvCloseBtn").addEventListener("click", () => {
      hide();
      document.dispatchEvent(new CustomEvent("match:closed"));
    });

    overlay.querySelector("#mvClaimBtn").addEventListener("click", async () => {
      const btn = overlay.querySelector("#mvClaimBtn");
      btn.disabled = true;
      btn.textContent = "Confirm in wallet…";
      try {
        await onClaimHandler?.();
        btn.textContent = "Claimed ✔";
        setNote("Winnings sent to your wallet.");
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Claim winnings";
        setNote(err?.message || "Claim failed — you can try again.", true);
      }
    });

    return overlay;
  }

  const $ = (id) => overlay?.querySelector(id);

  function setNote(text, isError = false) {
    const el = $("#mvResultNote");
    if (!el) return;
    el.textContent = text || "";
    el.dataset.tone = isError ? "warn" : "info";
  }

  function lineupHtml(players) {
    return (players || [])
      .map(
        (p) => `
        <li class="match-lineup-row">
          <span class="match-lineup-pos">${escapeHtml(p.slotPos || p.position || "")}</span>
          <span class="match-lineup-name">${escapeHtml(p.name || "—")}</span>
        </li>`
      )
      .join("");
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  /** Line-ups converge centre-screen before kickoff. */
  function showKickoff({ homeName, awayName, homePlayers, awayPlayers }) {
    build();
    stop();

    overlay.hidden = false;
    overlay.classList.add("match-overlay--kickoff");
    overlay.classList.remove("match-overlay--live");
    document.body.classList.add("match-open");

    $("#mvHomeName").textContent = homeName || "You";
    $("#mvAwayName").textContent = awayName || "Opponent";
    $("#mvHomeLineup").innerHTML = lineupHtml(homePlayers);
    $("#mvAwayLineup").innerHTML = lineupHtml(awayPlayers);

    $("#mvClock").textContent = "0'";
    $("#mvScore").textContent = "0 – 0";
    $("#mvPhase").textContent = "Kick off";
    $("#mvFeed").innerHTML = "";
    $("#mvResult").hidden = true;
    setNote("");
  }

  /**
   * Replays recorded ticks, paced so 90 minutes take ~75s.
   *
   * @param {object[]} logs         match_logs rows, ascending by seq
   * @param {object}   opts
   * @param {string}   opts.homeLabel  label for the 'creator' side
   * @param {string}   opts.awayLabel  label for the 'joiner'/'ai' side
   * @param {"creator"|"joiner"} opts.mySide
   * @param {number}   opts.fromMinute resume point after a refresh
   * @param {Function} opts.onFinished
   */
  function playMatch(logs, opts = {}) {
    build();
    stop();

    overlay.hidden = false;
    overlay.classList.remove("match-overlay--kickoff");
    overlay.classList.add("match-overlay--live");
    document.body.classList.add("match-open");
    $("#mvResult").hidden = true;

    const ordered = [...(logs || [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const startMinute = Math.max(0, Number(opts.fromMinute) || 0);

    // Anything already in the past is applied instantly, so a refresh mid-match
    // resumes at the right scoreline instead of replaying goals already seen.
    const feed = $("#mvFeed");
    feed.innerHTML = "";
    for (const log of ordered) {
      if ((log.minute ?? 0) <= startMinute) applyTick(log, opts, true);
    }

    const remaining = ordered.filter((l) => (l.minute ?? 0) > startMinute);
    const msPerMinute = MATCH_DURATION_MS / Math.max(1, FULL_TIME - startMinute);

    let minute = startMinute;
    timer = setInterval(() => {
      minute++;
      $("#mvClock").textContent = `${Math.min(minute, FULL_TIME)}'`;

      for (const log of remaining.filter((l) => l.minute === minute)) {
        applyTick(log, opts, false);
      }

      if (minute >= FULL_TIME) {
        stop();
        opts.onFinished?.();
      }
    }, msPerMinute);
  }

  function applyTick(log, opts, silent) {
    const type = log.event_type ?? log.eventType;
    const scoreC = Number(log.score_creator ?? log.scoreCreator ?? 0);
    const scoreJ = Number(log.score_joiner ?? log.scoreJoiner ?? 0);

    const mySide = opts.mySide === "joiner" ? "joiner" : "creator";
    const mine = mySide === "creator" ? scoreC : scoreJ;
    const theirs = mySide === "creator" ? scoreJ : scoreC;
    $("#mvScore").textContent = `${mine} – ${theirs}`;

    if (type === "goal") {
      const team = log.team;
      const forMe = team === mySide;
      const scorer = log.scorer_name ?? log.scorerName ?? "Unknown";
      addFeedLine(
        `${log.minute}'`,
        `⚽ ${escapeHtml(scorer)}`,
        forMe ? "for" : "against",
        silent
      );
      if (!silent) flashScore(forMe);
    } else if (type === "half_time") {
      $("#mvPhase").textContent = "Half time";
      addFeedLine(`${log.minute}'`, "Half time", "neutral", silent);
    } else if (type === "kickoff") {
      $("#mvPhase").textContent = "First half";
    } else if (type === "full_time") {
      $("#mvPhase").textContent = "Full time";
      addFeedLine(`${log.minute}'`, "Full time", "neutral", silent);
    } else if (type === "forfeit") {
      $("#mvPhase").textContent = "Forfeit";
      addFeedLine("—", "Opponent forfeited", "neutral", silent);
    }
  }

  function addFeedLine(minute, text, tone, silent) {
    const feed = $("#mvFeed");
    if (!feed) return;
    const row = document.createElement("div");
    row.className = "match-feed-row";
    row.dataset.tone = tone;
    if (silent) row.dataset.replayed = "1";
    row.innerHTML = `<span class="match-feed-min">${escapeHtml(minute)}</span><span class="match-feed-text">${text}</span>`;
    feed.appendChild(row);
    feed.scrollTop = feed.scrollHeight;
  }

  function flashScore(forMe) {
    const el = $("#mvScore");
    if (!el) return;
    el.dataset.flash = forMe ? "for" : "against";
    setTimeout(() => {
      if (el) delete el.dataset.flash;
    }, 900);
  }

  /**
   * Final screen. `canClaim` gates the claim button so a loser (or a winner whose
   * escrow has not settled yet) is never shown an action that would revert.
   */
  function showResult({ result, myScore, theirScore, scorers = [], canClaim, onClaim, note }) {
    build();
    stop();

    overlay.hidden = false;
    document.body.classList.add("match-open");
    onClaimHandler = onClaim || null;

    const headline =
      result === "win" ? "You win!" : result === "loss" ? "You lost" : "Draw";
    $("#mvResultHeadline").textContent = headline;
    $("#mvResultHeadline").dataset.result = result;

    const scorerText = scorers.length
      ? scorers.map((s) => `${escapeHtml(s.name)} ${s.minute}'`).join(", ")
      : "No goalscorers";
    $("#mvResultDetail").innerHTML =
      `<span class="match-result-score">${myScore} – ${theirScore}</span>` +
      `<span class="match-result-scorers">${scorerText}</span>`;

    const claimBtn = $("#mvClaimBtn");
    claimBtn.hidden = !canClaim;
    claimBtn.disabled = false;
    claimBtn.textContent = "Claim winnings";

    setNote(note || "");
    $("#mvResult").hidden = false;
    $("#mvPhase").textContent = "Full time";
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function hide() {
    stop();
    if (overlay) overlay.hidden = true;
    document.body.classList.remove("match-open");
  }

  function isOpen() {
    return Boolean(overlay && !overlay.hidden);
  }

  /** Goalscorers for the viewer's side, for the result screen. */
  function scorersFor(logs, side) {
    return (logs || [])
      .filter((l) => (l.event_type ?? l.eventType) === "goal" && l.team === side)
      .map((l) => ({ name: l.scorer_name ?? l.scorerName ?? "Unknown", minute: l.minute }));
  }

  return { showKickoff, playMatch, showResult, hide, stop, isOpen, scorersFor, MATCH_DURATION_MS };
})();
