"use client";

import { canPlayerFillSlot, getFlagUrl, ratingColor, shortName } from "@/lib/constants";

/**
 * SVG pitch lines overlay - renders goal boxes, center circle, etc.
 */
function PitchLines() {
  return (
    <svg className="pitch-lines" viewBox="0 0 78 120" preserveAspectRatio="none">
      {/* Outer boundary */}
      <rect x="2" y="2" width="74" height="116" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" />
      
      {/* Center line */}
      <line x1="2" y1="60" x2="76" y2="60" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" />
      
      {/* Center circle */}
      <circle cx="39" cy="60" r="9.15" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" />
      
      {/* Center spot */}
      <circle cx="39" cy="60" r="0.8" fill="rgba(255,255,255,0.3)" />
      
      {/* Top penalty area */}
      <rect x="18" y="2" width="42" height="16.5" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" />
      
      {/* Top goal area (6-yard box) */}
      <rect x="28" y="2" width="22" height="5.5" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" />
      
      {/* Top penalty spot */}
      <circle cx="39" cy="11" r="0.6" fill="rgba(255,255,255,0.3)" />
      
      {/* Top penalty arc */}
      <path d="M 28 18.5 A 9.15 9.15 0 0 0 50 18.5" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" />
      
      {/* Top goal */}
      <rect x="31" y="0" width="16" height="2" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="0.8" />
      
      {/* Bottom penalty area */}
      <rect x="18" y="101.5" width="42" height="16.5" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" />
      
      {/* Bottom goal area (6-yard box) */}
      <rect x="28" y="112.5" width="22" height="5.5" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" />
      
      {/* Bottom penalty spot */}
      <circle cx="39" cy="109" r="0.6" fill="rgba(255,255,255,0.3)" />
      
      {/* Bottom penalty arc */}
      <path d="M 28 101.5 A 9.15 9.15 0 0 1 50 101.5" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" />
      
      {/* Bottom goal */}
      <rect x="31" y="118" width="16" height="2" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="0.8" />
      
      {/* Corner arcs */}
      <path d="M 2 3 A 1 1 0 0 0 3 2" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" />
      <path d="M 75 2 A 1 1 0 0 0 76 3" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" />
      <path d="M 2 117 A 1 1 0 0 1 3 118" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" />
      <path d="M 75 118 A 1 1 0 0 1 76 117" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" />
    </svg>
  );
}

/**
 * Renders a football pitch with positioned player slots.
 *
 * @param {object} props
 * @param {Array} props.slots - Array of { pos, top, left, player, id }
 * @param {object|null} props.highlightPlayer - Player to highlight compatible slots for
 * @param {number|null} props.selectedSlotIdx - Currently selected placed slot index
 * @param {string|null} props.swapSourcePos - Position of the source slot when moving a
 *   placed player. When provided, occupied slots are also highlighted if a legal
 *   two-way swap is possible.
 * @param {function} props.onSlotClick - Called with slot index when a slot is clicked
 * @param {string} props.className - Optional extra class
 */
export default function PitchView({
  slots,
  highlightPlayer = null,
  selectedSlotIdx = null,
  swapSourcePos = null,
  onSlotClick,
  className = "",
}) {
  return (
    <div className={`pitch ${className}`}>
      <PitchLines />
      {slots.map((slot, idx) => {
        const hasPlayer = !!slot.player;
        const isSelected = idx === selectedSlotIdx;

        // Highlight logic: show which slots the selected player can fill or swap into
        let isCompatible = false;
        if (highlightPlayer && !isSelected) {
          if (!hasPlayer) {
            isCompatible = canPlayerFillSlot(highlightPlayer, slot.pos);
          } else if (swapSourcePos) {
            // Swap is legal only when both players fit each other's positions.
            isCompatible =
              canPlayerFillSlot(highlightPlayer, slot.pos) &&
              canPlayerFillSlot(slot.player, swapSourcePos);
          }
        }

        const rc = hasPlayer ? ratingColor(slot.player.rating) : null;
        const isElite = hasPlayer && slot.player.isLegendary;

        return (
          <button
            key={idx}
            className={`slot ${hasPlayer ? "slot--filled" : ""} ${isSelected ? "slot--active" : ""} ${isCompatible ? "slot--compatible" : ""} ${isElite ? "slot--elite" : ""}`}
            style={{ top: `${slot.top}%`, left: `${slot.left}%` }}
            onClick={() => onSlotClick?.(idx)}
            type="button"
            title={hasPlayer ? `${slot.player.name} (${slot.player.rating})` : slot.pos}
          >
            {hasPlayer ? (
              <>
                <span className="slot-player-name">{shortName(slot.player.name)}</span>
                <span className="slot-jersey-number" style={{ color: rc }}>
                  {slot.player.jerseyNumber || slot.player.rating}
                </span>
                {slot.player.draftedNation && (
                  <img
                    className="slot-flag"
                    src={getFlagUrl(slot.player.draftedNation)}
                    alt={slot.player.draftedNation}
                    loading="lazy"
                  />
                )}
              </>
            ) : (
              <span className="slot-label">{slot.pos}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
