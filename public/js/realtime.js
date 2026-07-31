// js/realtime.js — Supabase Realtime transport for duels
//
// Replaces the previous public piesocket demo relay and the localStorage
// "storage" event hack. Those had three fatal problems: the relay was a shared
// public endpoint with a hardcoded key (anyone could read or forge duel
// traffic), localStorage only ever worked between tabs of the same browser, and
// neither could tell you whether your opponent was still there.
//
// Live traffic rides a per-room broadcast channel. Presence gives us
// connect/disconnect detection. Durability is NOT provided here — the caller
// keeps a slow Postgres poll as the reconnection safety net, because broadcast
// messages are fire-and-forget and are lost if you are not subscribed.

const RealtimeManager = (() => {
  let client = null;
  let channel = null;
  let roomId = null;
  let selfId = null;
  let subscribed = false;

  let callbacks = {
    onEvent: null,
    onStatus: null,
    onPresence: null,
  };

  function cfg() {
    return (typeof window !== "undefined" && window.__FOOTMON_SUPABASE) || {};
  }

  function isConfigured() {
    const c = cfg();
    return Boolean(c.url && c.anonKey);
  }

  function libAvailable() {
    return typeof supabase !== "undefined" && typeof supabase.createClient === "function";
  }

  /** Whether live transport can work at all. Callers fall back to polling. */
  function isAvailable() {
    return isConfigured() && libAvailable();
  }

  function getClient() {
    if (!isAvailable()) {
      if (!isConfigured()) {
        console.error(
          "[Realtime] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are " +
            "not exposed to the browser. Falling back to slow polling only."
        );
      } else {
        console.error("[Realtime] supabase-js failed to load. Falling back to polling.");
      }
      return null;
    }

    if (!client) {
      const { url, anonKey } = cfg();
      client = supabase.createClient(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        // Draft picks are bursty; allow headroom over the default.
        realtime: { params: { eventsPerSecond: 20 } },
      });
    }
    return client;
  }

  function emitStatus(status, detail) {
    callbacks.onStatus?.({ status, detail: detail ?? null, roomId });
  }

  /** Flattens presence into the list of participant ids currently online. */
  function presentIds() {
    if (!channel) return [];
    const state = channel.presenceState() || {};
    const ids = new Set();
    for (const entries of Object.values(state)) {
      for (const entry of entries || []) {
        if (entry?.id) ids.add(entry.id);
      }
    }
    return [...ids];
  }

  function emitPresence() {
    const ids = presentIds();
    callbacks.onPresence?.({
      present: ids,
      // "Alone" is the signal the lobby uses for "waiting for opponent…".
      opponentPresent: ids.some((id) => id !== selfId),
      selfPresent: ids.includes(selfId),
    });
  }

  /**
   * Subscribes to a room.
   *
   * @param {string} nextRoomId
   * @param {{selfId: string, onEvent?: Function, onStatus?: Function, onPresence?: Function}} opts
   * @returns {Promise<boolean>} true when the live channel is up
   */
  async function join(nextRoomId, opts = {}) {
    await leave();

    roomId = nextRoomId;
    selfId = opts.selfId || `anon_${Math.random().toString(36).slice(2, 10)}`;
    callbacks = {
      onEvent: opts.onEvent || null,
      onStatus: opts.onStatus || null,
      onPresence: opts.onPresence || null,
    };

    const c = getClient();
    if (!c) {
      emitStatus("unavailable");
      return false;
    }

    emitStatus("connecting");

    channel = c.channel(`duel:${roomId}`, {
      config: {
        broadcast: { self: false, ack: false },
        presence: { key: selfId },
      },
    });

    channel.on("broadcast", { event: "duel" }, (message) => {
      callbacks.onEvent?.(message?.payload ?? null);
    });

    // These three presence bindings are NOT optional decoration: supabase-js
    // only maintains channel.presenceState() while a presence binding exists.
    // Remove them and presentIds() silently returns an empty list forever,
    // which would make every opponent look permanently disconnected.
    channel.on("presence", { event: "sync" }, emitPresence);
    channel.on("presence", { event: "join" }, emitPresence);
    channel.on("presence", { event: "leave" }, emitPresence);

    return new Promise((resolve) => {
      let settled = false;

      channel.subscribe(async (status, err) => {
        if (status === "SUBSCRIBED") {
          subscribed = true;
          try {
            await channel.track({ id: selfId, at: Date.now() });
          } catch {
            /* presence is best-effort */
          }
          emitStatus("connected");
          emitPresence();
          if (!settled) {
            settled = true;
            resolve(true);
          }
          return;
        }

        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          const wasSubscribed = subscribed;
          subscribed = false;
          // Broadcast messages sent while we were away are gone for good, so the
          // caller must re-sync from Postgres rather than assume continuity.
          emitStatus(status === "CLOSED" ? "disconnected" : "error", err?.message || status);
          if (wasSubscribed) emitStatus("resync-required");
          if (!settled) {
            settled = true;
            resolve(false);
          }
        }
      });

      // Never hang the UI on a channel that refuses to come up.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          emitStatus("timeout");
          resolve(false);
        }
      }, 8000);
    });
  }

  /**
   * Fire-and-forget send. Returns false when it could not go out, so the caller
   * knows to rely on the durable path instead of assuming delivery.
   */
  async function broadcast(payload) {
    if (!channel || !subscribed) return false;
    try {
      const res = await channel.send({ type: "broadcast", event: "duel", payload });
      return res === "ok" || res === undefined;
    } catch {
      return false;
    }
  }

  async function leave() {
    if (channel) {
      try {
        await channel.untrack();
      } catch {
        /* ignore */
      }
      try {
        await channel.unsubscribe();
      } catch {
        /* ignore */
      }
      try {
        client?.removeChannel(channel);
      } catch {
        /* ignore */
      }
    }
    channel = null;
    roomId = null;
    subscribed = false;
    callbacks = { onEvent: null, onStatus: null, onPresence: null };
  }

  function isLive() {
    return subscribed;
  }

  return { isAvailable, isConfigured, join, broadcast, leave, isLive, presentIds };
})();
