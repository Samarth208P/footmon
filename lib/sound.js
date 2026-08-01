/**
 * Procedural sound effects for the duel arena.
 *
 * All sounds are synthesised on the fly with the Web Audio API — zero
 * asset weight, zero network fetches, and every effect can be tuned by
 * editing a handful of numbers here rather than opening a DAW.
 *
 * Design contract
 * ───────────────
 * * A single shared AudioContext is created lazily on the first call.
 *   Browsers require a user gesture to unlock audio; the first sound
 *   trigger always comes from a click / keystroke / poll-driven change
 *   that follows one, so the context resumes cleanly.
 * * A master gain node lets us mute globally without touching individual
 *   sound implementations. The mute flag persists to localStorage so it
 *   survives navigation and refreshes.
 * * Each sound is a short chain of oscillators + optional noise buffer
 *   with envelopes measured in tens of milliseconds. Nothing blocks or
 *   keeps state — every sound schedules its nodes on the audio thread
 *   and stops itself once done.
 */

const isBrowser = typeof window !== "undefined";
const STORAGE_KEY = "footmon.sound.muted";
const DEFAULT_MASTER_GAIN = 0.35;

let ctx = null;
let master = null;
let muted = loadMuted();
const listeners = new Set();

function loadMuted() {
  if (!isBrowser) return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveMuted(m) {
  if (!isBrowser) return;
  try {
    localStorage.setItem(STORAGE_KEY, m ? "1" : "0");
  } catch {
    /* private mode / quota — no-op */
  }
}

function ensureContext() {
  if (!isBrowser) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : DEFAULT_MASTER_GAIN;
      master.connect(ctx.destination);
    } catch {
      ctx = null;
      master = null;
      return null;
    }
  }
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

/**
 * Prime the audio context on the first user gesture on the page so that
 * later programmatic sounds (my-turn splash, poll-driven transitions,
 * goal ticks) aren't blocked by autoplay policy.
 */
export function unlockOnFirstGesture() {
  if (!isBrowser) return () => {};
  const events = ["click", "keydown", "touchstart", "pointerdown"];
  const handler = () => {
    ensureContext();
    events.forEach((e) => window.removeEventListener(e, handler));
  };
  events.forEach((e) => window.addEventListener(e, handler, { passive: true }));
  return () => events.forEach((e) => window.removeEventListener(e, handler));
}

// ── Public mute API ─────────────────────────────────────────────────────────

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = Boolean(value);
  saveMuted(muted);
  if (master) master.gain.value = muted ? 0 : DEFAULT_MASTER_GAIN;
  listeners.forEach((cb) => {
    try { cb(muted); } catch { /* listener bug — swallow */ }
  });
}

export function toggleMuted() {
  setMuted(!muted);
  return muted;
}

/** Subscribe to mute state changes. Returns an unsubscribe. */
export function onMuteChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ── Low-level primitives ────────────────────────────────────────────────────

function tone({
  type = "sine",
  freq,
  freqEnd = null,
  duration = 0.2,
  gain = 0.3,
  attack = 0.005,
  release = 0.05,
  delay = 0,
}) {
  if (muted) return;
  const c = ensureContext();
  if (!c) return;
  const startAt = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startAt);
  if (freqEnd != null && freqEnd !== freq) {
    // exponentialRampToValueAtTime chokes on 0/negative — clamp to a tiny
    // positive value if the caller passes something bad.
    const safeEnd = Math.max(freqEnd, 0.001);
    osc.frequency.exponentialRampToValueAtTime(safeEnd, startAt + duration);
  }
  g.gain.setValueAtTime(0.0001, startAt);
  g.gain.exponentialRampToValueAtTime(gain, startAt + attack);
  g.gain.setValueAtTime(gain, startAt + Math.max(attack, duration - release));
  g.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(g).connect(master);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.05);
}

function noise({ duration = 0.2, gain = 0.15, filterFreq = null, filterQ = 1, delay = 0 }) {
  if (muted) return;
  const c = ensureContext();
  if (!c) return;
  const startAt = c.currentTime + delay;
  const bufferSize = Math.max(1, Math.floor(c.sampleRate * duration));
  const buf = c.createBuffer(1, bufferSize, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, startAt);
  g.gain.exponentialRampToValueAtTime(gain, startAt + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  if (filterFreq) {
    const flt = c.createBiquadFilter();
    flt.type = "bandpass";
    flt.frequency.value = filterFreq;
    flt.Q.value = filterQ;
    src.connect(flt).connect(g).connect(master);
  } else {
    src.connect(g).connect(master);
  }
  src.start(startAt);
}

// ── Sound library ───────────────────────────────────────────────────────────
// Musical notes referenced below (Hz):
//   C4 261.63, D4 293.66, E4 329.63, F4 349.23, G4 392, A4 440, B4 493.88
//   C5 523.25, D5 587.33, E5 659.25, G5 783.99, A5 880, C6 1046.5, E6 1318.5

export const sounds = {
  /** Wheel spin — noise burst + rising saw for that "dice tumbling" feel. */
  roll() {
    noise({ duration: 0.28, gain: 0.14, filterFreq: 900, filterQ: 2 });
    tone({ type: "sawtooth", freq: 220, freqEnd: 660, duration: 0.28, gain: 0.14 });
    tone({ type: "square", freq: 880, duration: 0.06, gain: 0.08, delay: 0.28 });
  },

  /** Reroll — shorter, brighter cousin of roll. */
  reroll() {
    tone({ type: "triangle", freq: 500, freqEnd: 780, duration: 0.14, gain: 0.18 });
    noise({ duration: 0.12, gain: 0.08, filterFreq: 1600 });
  },

  /** Player successfully assigned to a slot — bright two-note chime. */
  pickPlaced() {
    tone({ type: "sine", freq: 880, duration: 0.14, gain: 0.28 });
    tone({ type: "sine", freq: 1318.5, duration: 0.22, gain: 0.2, delay: 0.06 });
  },

  /** Opponent picked — same shape, lower pitch, quieter (peripheral cue). */
  opponentPicked() {
    tone({ type: "sine", freq: 523.25, duration: 0.12, gain: 0.14 });
    tone({ type: "sine", freq: 659.25, duration: 0.18, gain: 0.1, delay: 0.05 });
  },

  /** Slot swap — soft slide, up-then-down. */
  swap() {
    tone({ type: "triangle", freq: 660, freqEnd: 440, duration: 0.1, gain: 0.15 });
    tone({ type: "triangle", freq: 440, freqEnd: 660, duration: 0.1, gain: 0.15, delay: 0.09 });
  },

  /** "YOUR TURN" — ascending major arpeggio, celebratory but brief. */
  myTurn() {
    tone({ type: "sine", freq: 523.25, duration: 0.14, gain: 0.28 });
    tone({ type: "sine", freq: 659.25, duration: 0.14, gain: 0.28, delay: 0.11 });
    tone({ type: "sine", freq: 783.99, duration: 0.28, gain: 0.32, delay: 0.22 });
    tone({ type: "triangle", freq: 1046.5, duration: 0.35, gain: 0.22, delay: 0.28 });
  },

  /** Opponent's turn begins — softer descending pair, informational only. */
  opponentTurn() {
    tone({ type: "sine", freq: 440, duration: 0.14, gain: 0.14 });
    tone({ type: "sine", freq: 329.63, duration: 0.18, gain: 0.12, delay: 0.1 });
  },

  /** Opponent joined the room — bright welcome chirp. */
  opponentJoined() {
    tone({ type: "sine", freq: 587.33, duration: 0.14, gain: 0.22 });
    tone({ type: "sine", freq: 880, duration: 0.22, gain: 0.24, delay: 0.1 });
  },

  /** Ticking warning when the clock is running low. Play once per second. */
  timerWarn() {
    tone({ type: "square", freq: 240, duration: 0.05, gain: 0.16 });
  },

  /** Time's up — dramatic descending buzz. */
  timerExpire() {
    tone({ type: "sawtooth", freq: 220, freqEnd: 90, duration: 0.55, gain: 0.28 });
    noise({ duration: 0.4, gain: 0.1, filterFreq: 500, delay: 0.05 });
  },

  /** Goal! — rising fanfare + crowd noise. */
  goal() {
    tone({ type: "triangle", freq: 523.25, duration: 0.14, gain: 0.24 });
    tone({ type: "triangle", freq: 659.25, duration: 0.14, gain: 0.24, delay: 0.1 });
    tone({ type: "triangle", freq: 783.99, duration: 0.14, gain: 0.26, delay: 0.2 });
    tone({ type: "triangle", freq: 1046.5, duration: 0.4, gain: 0.32, delay: 0.3 });
    noise({ duration: 0.5, gain: 0.09, filterFreq: 3000, delay: 0.35 });
  },

  /** Victory reveal — big triumphant motif. */
  victory() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      tone({ type: "triangle", freq: f, duration: 0.2, gain: 0.3, delay: i * 0.13 });
    });
    tone({ type: "sine", freq: 1046.5, duration: 0.7, gain: 0.34, delay: 0.6 });
    tone({ type: "sine", freq: 1318.5, duration: 0.7, gain: 0.22, delay: 0.62 });
  },

  /** Defeat reveal — slow descending minor motif. */
  defeat() {
    tone({ type: "sine", freq: 392, duration: 0.32, gain: 0.24 });
    tone({ type: "sine", freq: 329.63, duration: 0.32, gain: 0.24, delay: 0.28 });
    tone({ type: "sine", freq: 261.63, duration: 0.6, gain: 0.28, delay: 0.55 });
  },

  /** Draw — neutral two-tone. */
  draw() {
    tone({ type: "sine", freq: 440, duration: 0.35, gain: 0.22 });
    tone({ type: "sine", freq: 440, duration: 0.35, gain: 0.22, delay: 0.32 });
  },

  /** Prize claimed — coin/cash chime. */
  claim() {
    tone({ type: "sine", freq: 1200, duration: 0.08, gain: 0.22 });
    tone({ type: "sine", freq: 1600, duration: 0.14, gain: 0.26, delay: 0.07 });
    tone({ type: "sine", freq: 2000, duration: 0.16, gain: 0.2, delay: 0.15 });
  },

  /** Generic error toast. */
  error() {
    tone({ type: "square", freq: 200, duration: 0.14, gain: 0.16 });
    tone({ type: "square", freq: 160, duration: 0.14, gain: 0.14, delay: 0.11 });
  },
};

/**
 * Convenience — safe to call with an unknown key, no-ops silently.
 */
export function play(name) {
  const fn = sounds[name];
  if (typeof fn === "function") fn();
}
