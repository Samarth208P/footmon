import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDuelScreen() {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "public", "js", "duel-screen.js"),
    "utf8"
  );
  const factory = new Function(
    "module",
    `${src}; return typeof DuelScreen !== "undefined" ? DuelScreen : module.exports;`
  );
  return factory({ exports: {} });
}

const CREATOR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const JOINER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const STRANGER = "0xcccccccccccccccccccccccccccccccccccccccc";

const room = (over = {}) => ({
  creator: CREATOR,
  joiner: JOINER,
  status: "drafting",
  score_creator: 0,
  score_joiner: 0,
  winner: null,
  is_draw: false,
  current_turn: null,
  ...over,
});

const log = (seq, eventType) => ({ seq, event_type: eventType });

describe("duel screen mapping", () => {
  let DS;
  beforeAll(() => {
    DS = loadDuelScreen();
  });

  it("shows the lobby with no room", () => {
    expect(DS.screenForRoom(null).screen).toBe("lobby");
  });

  it("shows waiting when nobody has joined", () => {
    expect(DS.screenForRoom(room({ status: "open", joiner: null })).screen).toBe("waiting");
  });

  it("shows the ready check once an opponent is present", () => {
    expect(DS.screenForRoom(room({ status: "open" })).screen).toBe("ready");
    expect(DS.screenForRoom(room({ status: "full" })).screen).toBe("ready");
    expect(DS.screenForRoom(room({ status: "ready" })).screen).toBe("ready");
  });

  it("shows the draft while drafting", () => {
    expect(DS.screenForRoom(room({ status: "drafting" })).screen).toBe("draft");
  });

  it("shows kickoff when simulating with no ticks yet", () => {
    expect(DS.screenForRoom(room({ status: "simulating" }), []).screen).toBe("kickoff");
  });

  it("resumes mid-match when ticks exist but the match is unfinished", () => {
    const logs = [log(0, "kickoff"), log(1, "goal"), log(2, "half_time")];
    expect(DS.screenForRoom(room({ status: "simulating" }), logs).screen).toBe("match");
  });

  it("shows the result when full time has been logged", () => {
    const logs = [log(0, "kickoff"), log(1, "goal"), log(2, "full_time")];
    expect(DS.screenForRoom(room({ status: "simulating" }), logs).screen).toBe("result");
  });

  it("shows the result after a forfeit", () => {
    const logs = [log(0, "kickoff"), log(1, "forfeit")];
    expect(DS.screenForRoom(room({ status: "simulating" }), logs).screen).toBe("result");
  });

  it("shows the result when complete", () => {
    expect(DS.screenForRoom(room({ status: "complete" })).screen).toBe("result");
  });

  it("returns to the lobby when cancelled or expired", () => {
    expect(DS.screenForRoom(room({ status: "cancelled" })).screen).toBe("lobby");
    expect(DS.screenForRoom(room({ status: "expired" })).screen).toBe("lobby");
  });

  it("falls back to the lobby on an unknown status", () => {
    const out = DS.screenForRoom(room({ status: "who_knows" }));
    expect(out.screen).toBe("lobby");
    expect(out.reason).toMatch(/unknown/);
  });

  it("uses the highest seq, not array order, to find the last event", () => {
    // Out-of-order arrival must not fool the mapping.
    const logs = [log(2, "full_time"), log(0, "kickoff"), log(1, "goal")];
    expect(DS.lastEventType(logs)).toBe("full_time");
    expect(DS.matchFinished(logs)).toBe(true);
  });

  it("does not treat a half time tick as the end of the match", () => {
    expect(DS.matchFinished([log(0, "kickoff"), log(1, "half_time")])).toBe(false);
  });
});

describe("turn helpers", () => {
  let DS;
  beforeAll(() => {
    DS = loadDuelScreen();
  });

  it("labels the turn from the viewer's perspective", () => {
    const r = room({ current_turn: CREATOR });
    expect(DS.turnLabel(r, CREATOR)).toBe("YOUR TURN");
    expect(DS.turnLabel(r, JOINER)).toBe("OPPONENT'S TURN");
    expect(DS.turnLabel(room(), CREATOR)).toBeNull();
  });

  it("is case insensitive about addresses", () => {
    const r = room({ current_turn: CREATOR });
    expect(DS.isMyTurn(r, CREATOR.toUpperCase())).toBe(true);
  });

  it("identifies which side the viewer is", () => {
    const r = room();
    expect(DS.sideOf(r, CREATOR)).toBe("creator");
    expect(DS.sideOf(r, JOINER)).toBe("joiner");
    expect(DS.sideOf(r, STRANGER)).toBeNull();
  });
});

describe("outcome", () => {
  let DS;
  beforeAll(() => {
    DS = loadDuelScreen();
  });

  it("is undecided before the match ends", () => {
    expect(DS.outcomeFor(room({ status: "drafting" }), CREATOR)).toBeNull();
    expect(DS.outcomeFor(room({ status: "simulating" }), CREATOR)).toBeNull();
  });

  it("reports a win with a claim available once settled", () => {
    const r = room({ status: "complete", winner: CREATOR, score_creator: 2, score_joiner: 1 });
    const out = DS.outcomeFor(r, CREATOR);
    expect(out.result).toBe("win");
    expect(out.myScore).toBe(2);
    expect(out.theirScore).toBe(1);
    expect(out.canClaim).toBe(true);
  });

  it("reports a loss with no claim", () => {
    const r = room({ status: "complete", winner: CREATOR, score_creator: 2, score_joiner: 1 });
    const out = DS.outcomeFor(r, JOINER);
    expect(out.result).toBe("loss");
    expect(out.myScore).toBe(1);
    expect(out.theirScore).toBe(2);
    expect(out.canClaim).toBe(false);
  });

  it("does not offer a claim while settlement is still pending", () => {
    // Winner decided but escrow not yet released: claiming would revert.
    const r = room({ status: "simulating", winner: CREATOR, score_creator: 1, score_joiner: 0 });
    const out = DS.outcomeFor(r, CREATOR);
    expect(out.result).toBe("win");
    expect(out.canClaim).toBe(false);
  });

  it("reports a draw with no claim", () => {
    const r = room({ status: "complete", is_draw: true, score_creator: 1, score_joiner: 1 });
    const out = DS.outcomeFor(r, CREATOR);
    expect(out.result).toBe("draw");
    expect(out.canClaim).toBe(false);
  });

  it("returns null for a spectator", () => {
    const r = room({ status: "complete", winner: CREATOR });
    expect(DS.outcomeFor(r, STRANGER)).toBeNull();
  });
});
