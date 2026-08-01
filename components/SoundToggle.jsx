"use client";

import { useEffect, useState } from "react";
import { isMuted, toggleMuted, onMuteChange } from "@/lib/sound";

/**
 * Small speaker-icon button that flips the global mute flag.
 *
 * Mute state is persisted to localStorage inside lib/sound.js, so the
 * button reads/writes to the same source. Multiple SoundToggle instances
 * on one page stay in sync via onMuteChange.
 */
export default function SoundToggle({ className = "" }) {
  const [muted, setMutedState] = useState(false);

  useEffect(() => {
    setMutedState(isMuted());
    return onMuteChange(setMutedState);
  }, []);

  const onClick = () => {
    const next = toggleMuted();
    setMutedState(next);
  };

  return (
    <button
      type="button"
      className={`sound-toggle ${muted ? "sound-toggle--muted" : ""} ${className}`}
      onClick={onClick}
      aria-label={muted ? "Unmute duel sounds" : "Mute duel sounds"}
      title={muted ? "Unmute duel sounds" : "Mute duel sounds"}
    >
      {muted ? (
        // Speaker with slash
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M11 5 6 9H2v6h4l5 4V5Z" fill="currentColor" />
          <path d="M22 9l-6 6M16 9l6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : (
        // Speaker with wave
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M11 5 6 9H2v6h4l5 4V5Z" fill="currentColor" />
          <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a8 8 0 0 1 0 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
        </svg>
      )}
    </button>
  );
}
