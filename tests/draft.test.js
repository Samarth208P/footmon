import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "ethers";
import { createClient } from "@supabase/supabase-js";

import {
  DUEL_SLOTS,
  SQUAD_SIZE,
  TOTAL_PICKS,
  addressToPick,
  canFillSlot,
  isDraftComplete,
  isTurnExpired,
  isValidSlotIndex,
  sideToPick,
  slotPositionFor,
  validatePick,
} from "@/lib/draft";

const chainState = {
  configured: true,
  open: { ok: true, stake: 50000000000000000n },
  joined: { ok: true, stake: 50000000000000000n },
};

vi.mock("@/lib/chain", () => ({
  isChainConfigured: () => chainState.configured,
  isResolverConfigured: () => false,
  verifyDuelOpen: async () => chainState.open,
  verifyDuelJoined: async () => chainState.joined,
  getContract: () => ({ duelHousePct: async () => 30n }),
  getResolverContract: () => {
    throw new Error("resolver disabled in tests");
  },
  readDuel: async () => ({ status: 2 }),
  DUEL_STATUS: { NONE: 0, OPEN: 1, FULL: 2, RESOLVED: 3, CANCELLED: 4, REFUNDED: 5 },
}));

const { POST: createRoomRoute } = await import("@/app/api/duels/rooms/route");
const { POST: joinRoomRoute } = await import("@/app/api/duels/rooms/[code]/join/route");
const { POST: sessionRoute } = await import("@/app/api/duels/rooms/[code]/session/route");
const { POST: readyRoute } = await import("@/app/api/duels/rooms/[code]/ready/route");
const { POST: pickRoute } = await import("@/app/api/duels/rooms/[code]/pick/route");
const { POST: forfeitRoute } = await import("@/app/api/duels/rooms/[code]/forfeit/route");
const { buildSessionMessage } = await import("@/lib/session");
const { updateRoom } = await import("@/lib/duel-store");

// ── pure rules ──────────────────────────────────────────────────────────────

describe("draft turn order", () => {
  it("alternates starting with the creator", () => {
    expect(sideToPick(0)).toBe("creator");
    expect(sideToPick(1)).toBe("joiner");
    expect(sideToPick(2)).toBe("creator");
    expect(sideToPick(21)).toBe("joiner");
  });

  it("returns null once every slot is picked", () => {
    expect(sideToPick(TOTAL_PICKS)).toBeNull();
    expect(sideToPick(TOTAL_PICKS + 5)).toBeNull();
    expect(isDraftComplete(TOTAL_PICKS)).toBe(true);
    expect(isDraftComplete(TOTAL_PICKS - 1)).toBe(false);
  });

  it("gives each side exactly eleven picks", () => {
    let creator = 0;
    let joiner = 0;
    for (let i = 0; i < TOTAL_PICKS; i++) {
      if (sideToPick(i) === "creator") creator++;
      else joiner++;
    }
    expect(creator).toBe(SQUAD_SIZE);
    expect(joiner).toBe(SQUAD_SIZE);
  });

  it("maps the turn to an address", () => {
    const args = { creator: "0xaaa", joiner: "0xbbb" };
    expect(addressToPick({ totalPicks: 0, ...args })).toBe("0xaaa");
    expect(addressToPick({ totalPicks: 1, ...args })).toBe("0xbbb");
    expect(addressToPick({ totalPicks: TOTAL_PICKS, ...args })).toBeNull();
  });

  it("rejects nonsense pick counts", () => {
    expect(sideToPick(-1)).toBeNull();
    expect(sideToPick(1.5)).toBeNull();
  });
});

describe("slot legality", () => {
  it("has eleven slots", () => {
    expect(DUEL_SLOTS).toHaveLength(11);
  });

  it("validates slot indexes", () => {
    expect(isValidSlotIndex(0)).toBe(true);
    expect(isValidSlotIndex(10)).toBe(true);
    expect(isValidSlotIndex(11)).toBe(false);
    expect(isValidSlotIndex(-1)).toBe(false);
    expect(isValidSlotIndex(1.5)).toBe(false);
  });

  it("only lets a keeper play in goal", () => {
    const gkIndex = DUEL_SLOTS.indexOf("GK");
    expect(canFillSlot(gkIndex, "GK")).toBe(true);
    expect(canFillSlot(gkIndex, "ST")).toBe(false);
    expect(canFillSlot(gkIndex, "CB")).toBe(false);
  });

  it("refuses a keeper in an outfield slot", () => {
    const stIndex = DUEL_SLOTS.indexOf("ST");
    expect(canFillSlot(stIndex, "GK")).toBe(false);
    expect(canFillSlot(stIndex, "ST")).toBe(true);
    expect(canFillSlot(stIndex, "CF")).toBe(true);
  });

  it("accepts compatible alternatives", () => {
    const cmIndex = DUEL_SLOTS.indexOf("CM");
    for (const pos of ["CM", "DM", "AM", "CDM", "CAM"]) {
      expect(canFillSlot(cmIndex, pos)).toBe(true);
    }
    expect(canFillSlot(cmIndex, "GK")).toBe(false);

    const lbIndex = DUEL_SLOTS.indexOf("LB");
    expect(canFillSlot(lbIndex, "LWB")).toBe(true);
    expect(canFillSlot(lbIndex, "RB")).toBe(false);
  });

  it("accepts a list of positions and mixed casing", () => {
    const lwIndex = DUEL_SLOTS.indexOf("LW");
    expect(canFillSlot(lwIndex, ["ST", "LW"])).toBe(true);
    expect(canFillSlot(lwIndex, "lw")).toBe(true);
    expect(canFillSlot(lwIndex, "ST,LW")).toBe(true);
    expect(canFillSlot(lwIndex, ["GK"])).toBe(false);
  });

  it("reports the slot position", () => {
    expect(slotPositionFor(0)).toBe("GK");
    expect(slotPositionFor(99)).toBeNull();
  });
});

describe("validatePick", () => {
  const base = {
    creator: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    joiner: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    totalPicks: 0,
    slotIndex: DUEL_SLOTS.indexOf("GK"),
    playerName: "Felix",
    playerPositions: "GK",
  };

  it("accepts a legal pick on your turn", () => {
    expect(validatePick({ ...base, sender: base.creator }).ok).toBe(true);
  });

  it("rejects a pick out of turn", () => {
    const r = validatePick({ ...base, sender: base.joiner });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(r.error).toMatch(/not your turn/i);
  });

  it("rejects a stranger", () => {
    const r = validatePick({ ...base, sender: "0xcccccccccccccccccccccccccccccccccccccccc" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });

  it("rejects an illegal position for the slot", () => {
    const r = validatePick({
      ...base,
      sender: base.creator,
      slotIndex: DUEL_SLOTS.indexOf("ST"),
      playerPositions: "GK",
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/cannot play/i);
  });

  it("rejects a slot that is already filled", () => {
    const r = validatePick({ ...base, sender: base.creator, usedSlotIndexes: [base.slotIndex] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(r.error).toMatch(/already filled/i);
  });

  it("rejects reusing the same footballer", () => {
    const r = validatePick({ ...base, sender: base.creator, usedPlayerNames: ["Felix"] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already in your squad/i);
  });

  it("rejects a bad slot index or missing name", () => {
    expect(validatePick({ ...base, sender: base.creator, slotIndex: 99 }).status).toBe(400);
    expect(validatePick({ ...base, sender: base.creator, playerName: "" }).status).toBe(400);
  });

  it("refuses to draft before an opponent exists", () => {
    const r = validatePick({ ...base, sender: base.creator, joiner: null });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
  });

  it("refuses picks once the draft is complete", () => {
    const r = validatePick({ ...base, sender: base.creator, totalPicks: TOTAL_PICKS });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already complete/i);
  });
});

describe("turn expiry", () => {
  it("is not expired before the deadline", () => {
    const future = new Date(Date.now() + 10_000).toISOString();
    expect(isTurnExpired(future)).toBe(false);
  });

  it("is expired after the deadline", () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    expect(isTurnExpired(past)).toBe(true);
  });

  it("treats a missing or invalid deadline as not expired", () => {
    expect(isTurnExpired(null)).toBe(false);
    expect(isTurnExpired("not-a-date")).toBe(false);
  });
});

// ── routes ──────────────────────────────────────────────────────────────────

const configured = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
);
if (!configured) console.error("\n[draft.test] SKIPPED: Supabase not configured.\n");

const randHex = (n) =>
  Array.from({ length: n }, () => "0123456789abcdef".charAt(Math.floor(Math.random() * 16))).join("");

function jsonRequest(body, headers = {}) {
  return new Request("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
}
const params = (code) => ({ params: Promise.resolve({ code }) });
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

describe.skipIf(!configured)("draft routes", () => {
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const createdRooms = [];

  beforeEach(() => {
    chainState.configured = true;
    chainState.open = { ok: true, stake: 50000000000000000n };
    chainState.joined = { ok: true, stake: 50000000000000000n };
  });

  afterAll(async () => {
    for (const id of createdRooms) await admin.from("duel_rooms").delete().eq("id", id);
  });

  /** Creates a room, joins it, and opens a session for both players. */
  async function setupDuel() {
    const creator = Wallet.createRandom();
    const joiner = Wallet.createRandom();

    const created = await (
      await createRoomRoute(
        jsonRequest({ duelId: `0x${randHex(64)}`, creator: creator.address })
      )
    ).json();
    createdRooms.push(created.room.id);
    const code = created.room.room_code;

    await joinRoomRoute(jsonRequest({ joiner: joiner.address }), params(code));

    const session = async (wallet) => {
      const payload = {
        address: wallet.address,
        roomCode: code,
        issuedAt: new Date().toISOString(),
        nonce: randHex(32),
      };
      const signature = await wallet.signMessage(buildSessionMessage(payload));
      const res = await sessionRoute(jsonRequest({ ...payload, signature }), params(code));
      return (await res.json()).token;
    };

    return {
      code,
      roomId: created.room.id,
      creator,
      joiner,
      creatorToken: await session(creator),
      joinerToken: await session(joiner),
    };
  }

  it("requires a session token to ready up", async () => {
    const d = await setupDuel();
    const res = await readyRoute(jsonRequest({}), params(d.code));
    expect(res.status).toBe(401);
  });

  it("starts the draft only when both players are ready", async () => {
    const d = await setupDuel();

    const first = await (
      await readyRoute(jsonRequest({}, bearer(d.creatorToken)), params(d.code))
    ).json();
    expect(first.bothReady).toBe(false);
    expect(first.room.status).toBe("ready");

    const second = await (
      await readyRoute(jsonRequest({}, bearer(d.joinerToken)), params(d.code))
    ).json();
    expect(second.bothReady).toBe(true);
    expect(second.room.status).toBe("drafting");
    expect(second.room.current_turn).toBe(d.creator.address.toLowerCase());
    // Seeds must be recorded before any pick so the match is reproducible.
    expect(second.room.draft_seed).toBeTruthy();
    expect(second.room.match_seed).toBeTruthy();
  });

  it("refuses picks before the draft starts", async () => {
    const d = await setupDuel();
    const res = await pickRoute(
      jsonRequest(
        { slotIndex: 0, playerName: "Felix", playerPositions: "GK" },
        bearer(d.creatorToken)
      ),
      params(d.code)
    );
    expect(res.status).toBe(409);
  });

  async function startDraft(d) {
    await readyRoute(jsonRequest({}, bearer(d.creatorToken)), params(d.code));
    await readyRoute(jsonRequest({}, bearer(d.joinerToken)), params(d.code));
  }

  it("accepts a legal pick and hands the turn over", async () => {
    const d = await setupDuel();
    await startDraft(d);

    const res = await pickRoute(
      jsonRequest(
        { slotIndex: 0, playerName: "Felix", playerPositions: "GK", playerRating: 78 },
        bearer(d.creatorToken)
      ),
      params(d.code)
    );
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.totalPicks).toBe(1);
    expect(json.nextTurn).toBe(d.joiner.address.toLowerCase());
    expect(json.slot.player_name).toBe("Felix");
  });

  it("rejects a pick made out of turn", async () => {
    const d = await setupDuel();
    await startDraft(d);

    // Creator picks first, so the joiner must not be able to jump in.
    const res = await pickRoute(
      jsonRequest(
        { slotIndex: 0, playerName: "Someone", playerPositions: "GK" },
        bearer(d.joinerToken)
      ),
      params(d.code)
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not your turn/i);
  });

  it("rejects an illegal position", async () => {
    const d = await setupDuel();
    await startDraft(d);

    const stIndex = DUEL_SLOTS.indexOf("ST");
    const res = await pickRoute(
      jsonRequest(
        { slotIndex: stIndex, playerName: "Keeper", playerPositions: "GK" },
        bearer(d.creatorToken)
      ),
      params(d.code)
    );
    expect(res.status).toBe(400);
  });

  it("rejects a token issued for a different room", async () => {
    const a = await setupDuel();
    const b = await setupDuel();
    await startDraft(b);

    const res = await pickRoute(
      jsonRequest(
        { slotIndex: 0, playerName: "Felix", playerPositions: "GK" },
        bearer(a.creatorToken)
      ),
      params(b.code)
    );
    expect(res.status).toBe(403);
  });

  it("rejects a forged token", async () => {
    const d = await setupDuel();
    await startDraft(d);
    const res = await pickRoute(
      jsonRequest(
        { slotIndex: 0, playerName: "Felix", playerPositions: "GK" },
        bearer("bogus.token")
      ),
      params(d.code)
    );
    expect(res.status).toBe(401);
  });

  it("rejects the same slot twice", async () => {
    const d = await setupDuel();
    await startDraft(d);

    const pick = (token, extra) =>
      pickRoute(jsonRequest({ ...extra }, bearer(token)), params(d.code));

    await pick(d.creatorToken, { slotIndex: 0, playerName: "Felix", playerPositions: "GK" });
    await pick(d.joinerToken, { slotIndex: 0, playerName: "Zoff", playerPositions: "GK" });

    // Creator's turn again — reusing their own slot 0 must fail.
    const res = await pick(d.creatorToken, {
      slotIndex: 0,
      playerName: "Taffarel",
      playerPositions: "GK",
    });
    expect(res.status).toBe(409);
  });

  it("refuses a forfeit while the clock is still running", async () => {
    const d = await setupDuel();
    await startDraft(d);

    // Creator is on the clock, so the joiner cannot claim a forfeit yet.
    const res = await forfeitRoute(
      jsonRequest({ reason: "timeout" }, bearer(d.joinerToken)),
      params(d.code)
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not expired/i);
  });

  it("refuses a forfeit claimed against the wrong player", async () => {
    const d = await setupDuel();
    await startDraft(d);

    // The creator is on the clock; the creator cannot forfeit their opponent.
    const res = await forfeitRoute(
      jsonRequest({ reason: "timeout" }, bearer(d.creatorToken)),
      params(d.code)
    );
    expect(res.status).toBe(409);
  });

  it("allows a forfeit once the opponent's clock expires", async () => {
    const d = await setupDuel();
    await startDraft(d);

    // Backdate the deadline: the creator has run out of time.
    await updateRoom(d.roomId, {
      turn_deadline: new Date(Date.now() - 5000).toISOString(),
    });

    const res = await forfeitRoute(
      jsonRequest({ reason: "timeout" }, bearer(d.joinerToken)),
      params(d.code)
    );
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.winner).toBe(d.joiner.address.toLowerCase());
    expect(json.forfeitedBy).toBe(d.creator.address.toLowerCase());
    // The resolver is disabled in tests, so settlement is reported as pending
    // rather than silently claimed as done.
    expect(json.settled).toBe(false);
    expect(json.settlementError).toBeTruthy();
  });
});
