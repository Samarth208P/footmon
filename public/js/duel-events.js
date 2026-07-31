// js/duel-events.js — pure event normalisation
//
// Duel events reach a client through two independent paths:
//
//   1. Supabase Realtime broadcast  — fast, but fire-and-forget and unordered
//   2. Postgres polling             — slow, ordered, durable (reconnect safety net)
//
// The same logical event therefore routinely arrives TWICE. Everything in this
// file is pure (no DOM, no network, no globals) so the dedupe and ordering rules
// can be unit tested directly.

const DuelEvents = (() => {
  const KNOWN_TYPES = new Set([
    "challenge_created",
    "challenge_joined",
    "ready",
    "roll_result",
    "pick_player",
    "turn_change",
    "draft_complete",
    "match_tick",
    "match_end",
    "duel_quit",
    "forfeit",
  ]);

  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function toEpochMs(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return null;
  }

  /**
   * Stable identity for an event.
   *
   * A durable row id is authoritative when present. Broadcasts have no row id,
   * so the sender supplies a client id; that same client id is persisted with
   * the row, which is what lets the two transports collapse onto one event.
   */
  function dedupeKey(event) {
    if (event.id !== null && event.id !== undefined) return `id:${event.id}`;
    if (event.clientEventId) return `cid:${event.clientEventId}`;
    // Last resort: sender + type + timestamp. Coarse, but better than treating
    // every redelivery as new.
    return `fallback:${event.sender}:${event.type}:${event.at}`;
  }

  /**
   * @param {object} raw
   * @param {"realtime"|"poll"} source
   * @returns {object|null} null when the event is unusable
   */
  function normalizeEvent(raw, source) {
    if (!isPlainObject(raw)) return null;

    const type = typeof raw.type === "string" ? raw.type : null;
    if (!type || !KNOWN_TYPES.has(type)) return null;

    const sender = typeof raw.sender === "string" && raw.sender ? raw.sender : null;
    if (!sender) return null;

    // Row id only exists on persisted events; reject nonsense values.
    let id = null;
    if (raw.id !== undefined && raw.id !== null) {
      const n = Number(raw.id);
      if (!Number.isFinite(n) || n < 0) return null;
      id = n;
    }

    const at =
      toEpochMs(raw.at) ??
      toEpochMs(raw.created_at) ??
      toEpochMs(raw.ts) ??
      null;

    const payload = isPlainObject(raw.payload) ? raw.payload : {};

    const clientEventId =
      typeof raw.clientEventId === "string" && raw.clientEventId
        ? raw.clientEventId
        : typeof payload.clientEventId === "string" && payload.clientEventId
          ? payload.clientEventId
          : null;

    const normalized = {
      id,
      clientEventId,
      type,
      sender,
      payload,
      at: at ?? 0,
      source: source === "realtime" ? "realtime" : "poll",
    };
    normalized.key = dedupeKey(normalized);
    return normalized;
  }

  /** Ordering: durable id first (authoritative), then timestamp, then type. */
  function compareEvents(a, b) {
    if (a.id !== null && b.id !== null) return a.id - b.id;
    if (a.at !== b.at) return a.at - b.at;
    if (a.id !== null) return -1;
    if (b.id !== null) return 1;
    return a.type.localeCompare(b.type);
  }

  /**
   * Merges incoming events into an existing ordered list.
   *
   * When a broadcast copy is already present and the durable copy arrives, the
   * existing entry is upgraded in place with the row id rather than duplicated —
   * otherwise a pick would render twice.
   *
   * @returns {{events: object[], added: object[]}}
   */
  function mergeEvents(existing, incoming) {
    const events = Array.isArray(existing) ? [...existing] : [];
    const added = [];

    const byKey = new Map();
    const byClientId = new Map();
    for (const event of events) {
      byKey.set(event.key, event);
      if (event.clientEventId) byClientId.set(event.clientEventId, event);
    }

    const list = Array.isArray(incoming) ? incoming : [incoming];

    for (const candidate of list) {
      if (!candidate) continue;

      // Exact same identity: nothing to do.
      if (byKey.has(candidate.key)) continue;

      // Same logical event previously seen over the other transport.
      if (candidate.clientEventId && byClientId.has(candidate.clientEventId)) {
        const seen = byClientId.get(candidate.clientEventId);
        if (seen.id === null && candidate.id !== null) {
          // Upgrade the broadcast copy to the durable one.
          byKey.delete(seen.key);
          seen.id = candidate.id;
          seen.source = candidate.source;
          seen.key = dedupeKey(seen);
          byKey.set(seen.key, seen);
        }
        continue;
      }

      events.push(candidate);
      byKey.set(candidate.key, candidate);
      if (candidate.clientEventId) byClientId.set(candidate.clientEventId, candidate);
      added.push(candidate);
    }

    events.sort(compareEvents);
    return { events, added };
  }

  /** Highest durable row id seen — the cursor for the catch-up poll. */
  function maxEventId(events) {
    let max = 0;
    for (const event of events || []) {
      if (event && typeof event.id === "number" && event.id > max) max = event.id;
    }
    return max;
  }

  /** Generates a client-side id so a broadcast can be matched to its row. */
  function newClientEventId() {
    const rand =
      typeof crypto !== "undefined" && crypto.getRandomValues
        ? Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
            b.toString(16).padStart(2, "0")
          ).join("")
        : Math.random().toString(16).slice(2, 18);
    return `${Date.now().toString(36)}_${rand}`;
  }

  return {
    KNOWN_TYPES,
    normalizeEvent,
    mergeEvents,
    compareEvents,
    dedupeKey,
    maxEventId,
    newClientEventId,
  };
})();

// Allow Node/Vitest to require this file without a bundler.
if (typeof module !== "undefined" && module.exports) {
  module.exports = DuelEvents;
}
