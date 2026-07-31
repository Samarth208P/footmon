import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * public/js/duel-events.js is a classic browser script (no imports), so it is
 * loaded here by evaluating it in a sandbox. It is intentionally pure, which is
 * what makes that safe and the rules below testable.
 */
function loadDuelEvents() {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "public", "js", "duel-events.js"),
    "utf8"
  );
  const factory = new Function(
    "module",
    "crypto",
    `${src}; return typeof DuelEvents !== "undefined" ? DuelEvents : module.exports;`
  );
  const moduleShim = { exports: {} };
  return factory(moduleShim, globalThis.crypto);
}

describe("duel event normalisation", () => {
  let DE;

  beforeAll(() => {
    DE = loadDuelEvents();
  });

  // ── normalizeEvent ────────────────────────────────────────────────────────

  it("normalises a persisted row from the poll transport", () => {
    const event = DE.normalizeEvent(
      {
        id: 42,
        duel_id: "abc",
        sender: "player-1",
        type: "pick_player",
        payload: { slot: 3, name: "Pele" },
        created_at: "2026-07-31T12:00:00.000Z",
      },
      "poll"
    );

    expect(event).not.toBeNull();
    expect(event.id).toBe(42);
    expect(event.type).toBe("pick_player");
    expect(event.sender).toBe("player-1");
    expect(event.payload.name).toBe("Pele");
    expect(event.at).toBe(Date.parse("2026-07-31T12:00:00.000Z"));
    expect(event.source).toBe("poll");
    expect(event.key).toBe("id:42");
  });

  it("normalises a broadcast without a row id", () => {
    const event = DE.normalizeEvent(
      {
        sender: "player-2",
        type: "roll_result",
        payload: { nation: "BRA" },
        clientEventId: "cid-1",
        ts: 1700000000000,
      },
      "realtime"
    );

    expect(event.id).toBeNull();
    expect(event.clientEventId).toBe("cid-1");
    expect(event.source).toBe("realtime");
    expect(event.key).toBe("cid:cid-1");
  });

  it("reads clientEventId out of the payload when not at top level", () => {
    const event = DE.normalizeEvent(
      { sender: "p", type: "ready", payload: { clientEventId: "nested" } },
      "realtime"
    );
    expect(event.clientEventId).toBe("nested");
  });

  it("defaults a missing payload to an empty object", () => {
    const event = DE.normalizeEvent({ sender: "p", type: "ready" }, "realtime");
    expect(event.payload).toEqual({});
  });

  it("coerces a non-object payload rather than trusting it", () => {
    const event = DE.normalizeEvent(
      { sender: "p", type: "ready", payload: "not-an-object" },
      "realtime"
    );
    expect(event.payload).toEqual({});
  });

  it.each([
    ["null input", null],
    ["a string", "nope"],
    ["an array", []],
    ["a missing type", { sender: "p" }],
    ["an unknown type", { sender: "p", type: "definitely_not_a_real_event" }],
    ["a missing sender", { type: "ready" }],
    ["an empty sender", { type: "ready", sender: "" }],
    ["a negative id", { id: -1, type: "ready", sender: "p" }],
    ["a non-numeric id", { id: "abc", type: "ready", sender: "p" }],
  ])("rejects %s", (_label, input) => {
    expect(DE.normalizeEvent(input, "poll")).toBeNull();
  });

  it("treats an unrecognised source as poll", () => {
    const event = DE.normalizeEvent({ sender: "p", type: "ready" }, "whatever");
    expect(event.source).toBe("poll");
  });

  // ── mergeEvents ───────────────────────────────────────────────────────────

  it("adds new events and reports what was added", () => {
    const a = DE.normalizeEvent({ id: 1, sender: "p", type: "ready" }, "poll");
    const b = DE.normalizeEvent({ id: 2, sender: "p", type: "roll_result" }, "poll");

    const first = DE.mergeEvents([], [a]);
    expect(first.events).toHaveLength(1);
    expect(first.added).toHaveLength(1);

    const second = DE.mergeEvents(first.events, [b]);
    expect(second.events).toHaveLength(2);
    expect(second.added).toEqual([b]);
  });

  it("ignores a replayed identical row", () => {
    const a = DE.normalizeEvent({ id: 7, sender: "p", type: "ready" }, "poll");
    const again = DE.normalizeEvent({ id: 7, sender: "p", type: "ready" }, "poll");

    const merged = DE.mergeEvents([a], [again]);
    expect(merged.events).toHaveLength(1);
    expect(merged.added).toHaveLength(0);
  });

  it("collapses the same event arriving by broadcast then poll", () => {
    // Broadcast lands first (no row id yet).
    const broadcast = DE.normalizeEvent(
      { sender: "p", type: "pick_player", clientEventId: "cid-9", ts: 1000 },
      "realtime"
    );
    const afterBroadcast = DE.mergeEvents([], [broadcast]);
    expect(afterBroadcast.events).toHaveLength(1);

    // The durable copy of the SAME event arrives on the safety-net poll.
    const durable = DE.normalizeEvent(
      { id: 55, sender: "p", type: "pick_player", payload: { clientEventId: "cid-9" } },
      "poll"
    );
    const afterPoll = DE.mergeEvents(afterBroadcast.events, [durable]);

    // Must not render the pick twice.
    expect(afterPoll.events).toHaveLength(1);
    expect(afterPoll.added).toHaveLength(0);
    // ...and the surviving entry is upgraded to the durable id.
    expect(afterPoll.events[0].id).toBe(55);
    expect(afterPoll.events[0].key).toBe("id:55");
    expect(afterPoll.events[0].source).toBe("poll");
  });

  it("collapses the same event arriving by poll then broadcast", () => {
    const durable = DE.normalizeEvent(
      { id: 60, sender: "p", type: "pick_player", payload: { clientEventId: "cid-10" } },
      "poll"
    );
    const broadcast = DE.normalizeEvent(
      { sender: "p", type: "pick_player", clientEventId: "cid-10" },
      "realtime"
    );

    const merged = DE.mergeEvents([durable], [broadcast]);
    expect(merged.events).toHaveLength(1);
    expect(merged.added).toHaveLength(0);
    expect(merged.events[0].id).toBe(60);
  });

  it("keeps distinct events from the same sender separate", () => {
    const one = DE.normalizeEvent(
      { sender: "p", type: "pick_player", clientEventId: "cid-a" },
      "realtime"
    );
    const two = DE.normalizeEvent(
      { sender: "p", type: "pick_player", clientEventId: "cid-b" },
      "realtime"
    );
    const merged = DE.mergeEvents([], [one, two]);
    expect(merged.events).toHaveLength(2);
  });

  it("orders by durable id ahead of timestamp", () => {
    const later = DE.normalizeEvent({ id: 2, sender: "p", type: "ready", ts: 1 }, "poll");
    const earlier = DE.normalizeEvent({ id: 1, sender: "p", type: "ready", ts: 999 }, "poll");

    const merged = DE.mergeEvents([], [later, earlier]);
    expect(merged.events.map((e) => e.id)).toEqual([1, 2]);
  });

  it("orders id-less broadcasts by timestamp", () => {
    const b = DE.normalizeEvent(
      { sender: "p", type: "ready", clientEventId: "b", ts: 200 },
      "realtime"
    );
    const a = DE.normalizeEvent(
      { sender: "p", type: "ready", clientEventId: "a", ts: 100 },
      "realtime"
    );
    const merged = DE.mergeEvents([], [b, a]);
    expect(merged.events.map((e) => e.clientEventId)).toEqual(["a", "b"]);
  });

  it("accepts a single event as well as an array", () => {
    const a = DE.normalizeEvent({ id: 1, sender: "p", type: "ready" }, "poll");
    const merged = DE.mergeEvents([], a);
    expect(merged.events).toHaveLength(1);
  });

  it("tolerates nulls in the incoming batch", () => {
    const a = DE.normalizeEvent({ id: 1, sender: "p", type: "ready" }, "poll");
    const merged = DE.mergeEvents([], [null, a, undefined]);
    expect(merged.events).toHaveLength(1);
  });

  it("does not mutate the array it was given", () => {
    const a = DE.normalizeEvent({ id: 1, sender: "p", type: "ready" }, "poll");
    const original = [a];
    const b = DE.normalizeEvent({ id: 2, sender: "p", type: "ready" }, "poll");

    DE.mergeEvents(original, [b]);
    expect(original).toHaveLength(1);
  });

  // ── cursor ────────────────────────────────────────────────────────────────

  it("computes the catch-up cursor from durable ids only", () => {
    const events = [
      DE.normalizeEvent({ id: 3, sender: "p", type: "ready" }, "poll"),
      DE.normalizeEvent({ sender: "p", type: "ready", clientEventId: "x" }, "realtime"),
      DE.normalizeEvent({ id: 9, sender: "p", type: "ready" }, "poll"),
    ];
    expect(DE.maxEventId(events)).toBe(9);
  });

  it("returns cursor 0 for an empty or id-less list", () => {
    expect(DE.maxEventId([])).toBe(0);
    expect(DE.maxEventId(undefined)).toBe(0);
    expect(
      DE.maxEventId([
        DE.normalizeEvent({ sender: "p", type: "ready", clientEventId: "x" }, "realtime"),
      ])
    ).toBe(0);
  });

  // ── client event ids ──────────────────────────────────────────────────────

  it("generates unique client event ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => DE.newClientEventId()));
    expect(ids.size).toBe(500);
  });
});
