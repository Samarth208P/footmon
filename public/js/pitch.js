// js/pitch.js — Football pitch rendering (slots + player cards)

const PitchRenderer = (() => {

  // ── Pitch SVG lines ────────────────────────────────────────────────────────
  const PITCH_SVG = `
<svg class="pitch-lines" viewBox="0 0 780 1200" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">
  <defs>
    <!-- Goal net grid pattern -->
    <pattern id="net-grid" width="8" height="8" patternUnits="userSpaceOnUse">
      <path d="M 8 0 L 0 0 0 8" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="0.8"/>
    </pattern>
  </defs>

  <!-- Outer boundary box (Touchlines at 2 and 778, Goal lines at 30 and 1170) -->
  <rect x="2" y="30" width="776" height="1140" fill="none" stroke="rgba(255,255,255,0.38)" stroke-width="2.5"/>
  
  <!-- Halfway line -->
  <line x1="2" y1="600" x2="778" y2="600" stroke="rgba(255,255,255,0.38)" stroke-width="2.5"/>
  
  <!-- Centre circle (10 yards radius = 110 units) -->
  <circle cx="390" cy="600" r="110" fill="none" stroke="rgba(255,255,255,0.38)" stroke-width="2.5"/>
  <circle cx="390" cy="600" r="4.5" fill="rgba(255,255,255,0.7)"/>

  <!-- Top penalty area (44 yards wide, 18 yards deep) -->
  <rect x="170" y="30" width="440" height="180" fill="none" stroke="rgba(255,255,255,0.38)" stroke-width="2.5"/>
  <!-- Top goal area (20 yards wide, 6 yards deep) -->
  <rect x="290" y="30" width="200" height="60" fill="none" stroke="rgba(255,255,255,0.38)" stroke-width="2.5"/>
  <!-- Top penalty spot (12 yards from goal line) -->
  <circle cx="390" cy="150" r="4" fill="rgba(255,255,255,0.7)"/>
  <!-- Top penalty arc (10 yards radius from penalty spot) -->
  <path d="M 310 210 A 100 100 0 0 0 470 210" fill="none" stroke="rgba(255,255,255,0.38)" stroke-width="2.5"/>
  <!-- Top goal net (off-pitch) -->
  <rect x="350" y="5" width="80" height="25" fill="url(#net-grid)" stroke="rgba(255,255,255,0.38)" stroke-width="2"/>

  <!-- Bottom penalty area (44 yards wide, 18 yards deep) -->
  <rect x="170" y="990" width="440" height="180" fill="none" stroke="rgba(255,255,255,0.38)" stroke-width="2.5"/>
  <!-- Bottom goal area (20 yards wide, 6 yards deep) -->
  <rect x="290" y="1110" width="200" height="60" fill="none" stroke="rgba(255,255,255,0.38)" stroke-width="2.5"/>
  <!-- Bottom penalty spot (12 yards from goal line) -->
  <circle cx="390" cy="1050" r="4" fill="rgba(255,255,255,0.7)"/>
  <!-- Bottom penalty arc (10 yards radius from penalty spot) -->
  <path d="M 310 990 A 100 100 0 0 1 470 990" fill="none" stroke="rgba(255,255,255,0.38)" stroke-width="2.5"/>
  <!-- Bottom goal net (off-pitch) -->
  <rect x="350" y="1170" width="80" height="25" fill="url(#net-grid)" stroke="rgba(255,255,255,0.38)" stroke-width="2"/>

  <!-- Corner arcs (1 yard radius) -->
  <!-- Top-left -->
  <path d="M 12 30 A 10 10 0 0 1 2 40" fill="none" stroke="rgba(255,255,255,0.38)" stroke-width="2.5"/>
  <!-- Top-right -->
  <path d="M 778 40 A 10 10 0 0 1 768 30" fill="none" stroke="rgba(255,255,255,0.38)" stroke-width="2.5"/>
  <!-- Bottom-left -->
  <path d="M 2 1160 A 10 10 0 0 1 12 1170" fill="none" stroke="rgba(255,255,255,0.38)" stroke-width="2.5"/>
  <!-- Bottom-right -->
  <path d="M 768 1170 A 10 10 0 0 1 778 1160" fill="none" stroke="rgba(255,255,255,0.38)" stroke-width="2.5"/>
</svg>`;

  function ratingColor(r, isLegendary) {
    if (isLegendary) return "#f0c040";
    if (r >= 80) return "#34d399";
    if (r >= 70) return "#94a3b8";
    return "#64748b";
  }

  function getJerseyNumber(player, slotPos) {
    if (player.jerseyNumber !== undefined && player.jerseyNumber !== null && player.jerseyNumber > 0) {
      return player.jerseyNumber;
    }
    if (player.jersey !== undefined && player.jersey !== null && player.jersey > 0) {
      return player.jersey;
    }
    if (slotPos === "GK") return 1;
    let hash = 0;
    for (let i = 0; i < player.id.length; i++) {
      hash = player.id.charCodeAt(i) + ((hash << 5) - hash);
    }
    let num = (Math.abs(hash) % 98) + 2;
    return num;
  }

  /**
   * Render all slots onto the pitch container element.
   * @param {HTMLElement} pitchEl  – element with class "pitch"
   * @param {Array}       slots    – Game.state.slots
   * @param {Object|null} highlightPlayer – player to check compatibility for highlighting slots
   * @param {number|null} selectedPlacedSlotIdx – slot index currently selected for moving
   * @param {Function}    onSlotClick
   */
  function render(pitchEl, slots, highlightPlayer, selectedPlacedSlotIdx, onSlotClick) {
    // Inject SVG once
    if (!pitchEl.querySelector(".pitch-lines")) {
      pitchEl.insertAdjacentHTML("afterbegin", PITCH_SVG);
    }

    // Remove old slot elements
    pitchEl.querySelectorAll(".slot").forEach(el => el.remove());

    slots.forEach((slot, idx) => {
      const el = document.createElement("div");
      el.className = "slot";
      
      const isCompatible = highlightPlayer && !slot.player && Game.canPlayerFillSlot(highlightPlayer, slot.pos);
      if (isCompatible)                 el.classList.add("slot--compatible");
      if (selectedPlacedSlotIdx === idx) el.classList.add("slot--active");
      if (slot.player)                  el.classList.add("slot--filled");

      el.style.top  = `${slot.top}%`;
      el.style.left = `${slot.left}%`;

      if (slot.player) {
        const p = slot.player;
        const jerseyNum = getJerseyNumber(p, slot.pos);
        el.style.borderColor = ratingColor(p.rating, !!p.isLegendary);
        el.style.borderWidth = "2.5px";
        // Add glow for elite players
        if (p.isLegendary) el.classList.add("slot--elite");
        el.innerHTML = `
          <div class="slot-player-jersey">
            <span class="slot-jersey-number">${jerseyNum}</span>
          </div>
        `;
      } else {
        el.style.borderColor = "";
        el.style.borderWidth = "";
        el.innerHTML = `<span class="slot-label">${slot.pos}</span>`;
      }

      el.addEventListener("click", () => onSlotClick(idx));
      pitchEl.appendChild(el);
    });
  }

  function shortName(name) {
    // "Gabriel Jesus" → "G. Jesus"
    const parts = name.trim().split(" ");
    if (parts.length <= 1) return name;
    return parts[0][0] + ". " + parts.slice(1).join(" ");
  }

  return { render, ratingColor, shortName };
})();
