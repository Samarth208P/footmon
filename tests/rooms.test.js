import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "ethers";
import { createClient } from "@supabase/supabase-js";

/**
 * The chain layer is mocked here. Its real behaviour was verified end-to-end
 * against Monad testnet in Task 3 (create → join → resolve → claim); this suite
 * is about the room/password/session logic, which must be deterministic.
 */
const chainState = {
  configured: true,
  open: { ok: true, stake: 50000000000000000n },
  joined: { ok: true, stake: 50000000000000000n },
};

vi.mock("@/lib/chain", () => ({
  isChainConfigured: () => chainState.configured,
  isResolverConfigured: () => true,
  verifyDuelOpen: async () => chainState.open,
  verifyDuelJoined: async () => chainState.joined,
  DUEL_STATUS: { NONE: 0, OPEN: 1, FULL: 2, RESOLVED: 3, CANCELLED: 4, REFUNDED: 5 },
}));

const { POST: createRoomRoute, GET: listRoomsRoute } = await import(
  "@/app/api/duels/rooms/route"
);
const { GET: getRoomRoute } = await import("@/app/api/duels/rooms/[code]/route");
const { POST: joinRoomRoute } = await import("@/app/api/duels/rooms/[code]/join/route");
const { POST: sessionRoute } = await import("@/app/api/duels/rooms/[code]/session/route");

const { buildSessionMessage, verifySessionToken } = await import("@/lib/session");
const { hashPassword, verifyPassword } = await import("@/lib/password");
const { generateRoomCode, isValidRoomCode, normaliseRoomCode } = await import(
  "@/lib/room-code"
);

const configured = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
);
if (!configured) {
  console.error("\n[rooms.test] SKIPPED: Supabase not configured.\n");
}

const randHex = (n) =>
  Array.from({ length: n }, () => "0123456789abcdef".charAt(Math.floor(Math.random() * 16))).join("");
const newDuelId = () => `0x${randHex(64)}`;
const newAddress = () => `0x${randHex(40)}`;

function jsonRequest(url, body, headers = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const params = (code) => ({ params: Promise.resolve({ code }) });

// ── pure units ──────────────────────────────────────────────────────────────

describe("room codes", () => {
  it("generates codes matching the database constraint", () => {
    for (let i = 0; i < 200; i++) {
      expect(isValidRoomCode(generateRoomCode())).toBe(true);
    }
  });

  it("omits characters that are easy to misread", () => {
    const codes = Array.from({ length: 300 }, generateRoomCode).join("");
    expect(codes).not.toMatch(/[01OI]/);
  });

  it("normalises pasted input", () => {
    expect(normaliseRoomCode("  abc123  ")).toBe("ABC123");
  });

  it("rejects malformed codes", () => {
    expect(isValidRoomCode("abc")).toBe(false);
    expect(isValidRoomCode("TOOLONGCODE12")).toBe(false);
    expect(isValidRoomCode("BAD-CODE")).toBe(false);
  });
});

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("correct horse");
    expect(await verifyPassword("correct horse", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct horse");
    expect(await verifyPassword("wrong horse", hash)).toBe(false);
  });

  it("salts each hash so identical passwords differ", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("never stores the password in the hash", async () => {
    const hash = await hashPassword("SuperSecret123");
    expect(hash).not.toContain("SuperSecret123");
    expect(hash.startsWith("scrypt$")).toBe(true);
  });

  it("denies access on a malformed stored hash instead of throwing", async () => {
    for (const bad of ["", "nonsense", "scrypt$only$three", "bcrypt$1$2$3$4$5"]) {
      expect(await verifyPassword("anything", bad)).toBe(false);
    }
  });
});

// ── routes ──────────────────────────────────────────────────────────────────

describe.skipIf(!configured)("duel rooms API", () => {
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
    for (const id of createdRooms) {
      await admin.from("duel_rooms").delete().eq("id", id);
    }
  });

  async function makeRoom({ isPrivate = false, password = null, creator = newAddress() } = {}) {
    const res = await createRoomRoute(
      jsonRequest("http://localhost/api/duels/rooms", {
        duelId: newDuelId(),
        creator,
        isPrivate,
        password,
      })
    );
    const json = await res.json();
    if (json.room?.id) createdRooms.push(json.room.id);
    return { res, json };
  }

  it("creates a public room and lists it in the lobby", async () => {
    const { res, json } = await makeRoom();
    expect(res.status).toBe(201);
    expect(isValidRoomCode(json.room.room_code)).toBe(true);
    expect(json.room.is_private).toBe(false);
    // Stake comes from the chain, not the request body.
    expect(String(json.room.stake)).toBe("50000000000000000");

    const lobby = await (await listRoomsRoute()).json();
    expect(lobby.rooms.some((r) => r.room_code === json.room.room_code)).toBe(true);
  });

  it("keeps a private room out of the public lobby", async () => {
    const { res, json } = await makeRoom({ isPrivate: true, password: "letmein" });
    expect(res.status).toBe(201);
    expect(json.room.is_private).toBe(true);

    const lobby = await (await listRoomsRoute()).json();
    expect(lobby.rooms.some((r) => r.room_code === json.room.room_code)).toBe(false);
  });

  it("never returns the password hash", async () => {
    const { json } = await makeRoom({ isPrivate: true, password: "letmein" });
    expect(json.room.password_hash).toBeUndefined();

    const fetched = await (
      await getRoomRoute(new Request("http://localhost"), params(json.room.room_code))
    ).json();
    expect(fetched.room.password_hash).toBeUndefined();
    expect(JSON.stringify(fetched)).not.toContain("scrypt$");
  });

  it("requires a usable password for a private room", async () => {
    const res = await createRoomRoute(
      jsonRequest("http://localhost/api/duels/rooms", {
        duelId: newDuelId(),
        creator: newAddress(),
        isPrivate: true,
        password: "ab",
      })
    );
    expect(res.status).toBe(400);
  });

  it("rejects a malformed duelId or creator", async () => {
    const bad1 = await createRoomRoute(
      jsonRequest("http://localhost/api/duels/rooms", { duelId: "0x123", creator: newAddress() })
    );
    expect(bad1.status).toBe(400);

    const bad2 = await createRoomRoute(
      jsonRequest("http://localhost/api/duels/rooms", { duelId: newDuelId(), creator: "nope" })
    );
    expect(bad2.status).toBe(400);
  });

  it("refuses to register a room with no escrow on-chain", async () => {
    chainState.open = { ok: false, error: "No such duel is escrowed on-chain" };
    const res = await createRoomRoute(
      jsonRequest("http://localhost/api/duels/rooms", {
        duelId: newDuelId(),
        creator: newAddress(),
      })
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/escrowed on-chain/i);
  });

  it("is idempotent for the same duelId", async () => {
    const duelId = newDuelId();
    const creator = newAddress();
    const body = { duelId, creator };

    const first = await createRoomRoute(jsonRequest("http://localhost/api/duels/rooms", body));
    const firstJson = await first.json();
    createdRooms.push(firstJson.room.id);
    expect(first.status).toBe(201);

    const second = await createRoomRoute(jsonRequest("http://localhost/api/duels/rooms", body));
    const secondJson = await second.json();
    expect(secondJson.existing).toBe(true);
    expect(secondJson.room.id).toBe(firstJson.room.id);
  });

  // ── joining ──────────────────────────────────────────────────────────────

  it("joins a public room without a password", async () => {
    const { json } = await makeRoom();
    const joiner = newAddress();

    const res = await joinRoomRoute(
      jsonRequest("http://localhost/join", { joiner }),
      params(json.room.room_code)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.room.joiner).toBe(joiner.toLowerCase());
    expect(body.room.status).toBe("full");
  });

  it("joins a private room with the correct password", async () => {
    const { json } = await makeRoom({ isPrivate: true, password: "hunter22" });
    const res = await joinRoomRoute(
      jsonRequest("http://localhost/join", { joiner: newAddress(), password: "hunter22" }),
      params(json.room.room_code)
    );
    expect(res.status).toBe(200);
  });

  it("rejects a wrong password with 403", async () => {
    const { json } = await makeRoom({ isPrivate: true, password: "hunter22" });
    const res = await joinRoomRoute(
      jsonRequest("http://localhost/join", { joiner: newAddress(), password: "nope" }),
      params(json.room.room_code)
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/password/i);
  });

  it("rejects a missing password on a private room", async () => {
    const { json } = await makeRoom({ isPrivate: true, password: "hunter22" });
    const res = await joinRoomRoute(
      jsonRequest("http://localhost/join", { joiner: newAddress() }),
      params(json.room.room_code)
    );
    expect(res.status).toBe(403);
  });

  it("does not mutate the room when the password is wrong", async () => {
    const { json } = await makeRoom({ isPrivate: true, password: "hunter22" });
    await joinRoomRoute(
      jsonRequest("http://localhost/join", { joiner: newAddress(), password: "wrong" }),
      params(json.room.room_code)
    );

    const after = await (
      await getRoomRoute(new Request("http://localhost"), params(json.room.room_code))
    ).json();
    expect(after.room.joiner).toBeNull();
    expect(after.room.status).toBe("open");
  });

  it("refuses a self-join", async () => {
    const creator = newAddress();
    const { json } = await makeRoom({ creator });
    const res = await joinRoomRoute(
      jsonRequest("http://localhost/join", { joiner: creator }),
      params(json.room.room_code)
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/your own duel/i);
  });

  it("refuses a second opponent", async () => {
    const { json } = await makeRoom();
    await joinRoomRoute(
      jsonRequest("http://localhost/join", { joiner: newAddress() }),
      params(json.room.room_code)
    );
    const res = await joinRoomRoute(
      jsonRequest("http://localhost/join", { joiner: newAddress() }),
      params(json.room.room_code)
    );
    expect(res.status).toBe(409);
  });

  it("is idempotent for a retried join by the same player", async () => {
    const { json } = await makeRoom();
    const joiner = newAddress();
    await joinRoomRoute(
      jsonRequest("http://localhost/join", { joiner }),
      params(json.room.room_code)
    );
    const again = await joinRoomRoute(
      jsonRequest("http://localhost/join", { joiner }),
      params(json.room.room_code)
    );
    expect(again.status).toBe(200);
    expect((await again.json()).alreadyJoined).toBe(true);
  });

  it("refuses to join when the stake is not escrowed on-chain", async () => {
    const { json } = await makeRoom();
    chainState.joined = { ok: false, error: "Both stakes are not escrowed on-chain yet" };

    const res = await joinRoomRoute(
      jsonRequest("http://localhost/join", { joiner: newAddress() }),
      params(json.room.room_code)
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not escrowed/i);
  });

  it("returns 404 for an unknown room code", async () => {
    const res = await joinRoomRoute(
      jsonRequest("http://localhost/join", { joiner: newAddress() }),
      params("ZZZZZZZZ")
    );
    expect(res.status).toBe(404);
  });

  it("rejects a malformed room code", async () => {
    const res = await getRoomRoute(new Request("http://localhost"), params("!!"));
    expect(res.status).toBe(400);
  });

  it("looks a room up case-insensitively", async () => {
    const { json } = await makeRoom();
    const res = await getRoomRoute(
      new Request("http://localhost"),
      params(json.room.room_code.toLowerCase())
    );
    expect(res.status).toBe(200);
  });

  // ── sessions ─────────────────────────────────────────────────────────────

  async function signSession(wallet, roomCode, overrides = {}) {
    const payload = {
      address: wallet.address,
      roomCode,
      issuedAt: new Date().toISOString(),
      nonce: randHex(32),
      ...overrides,
    };
    const signature = await wallet.signMessage(buildSessionMessage(payload));
    return { ...payload, signature };
  }

  it("issues a room-scoped session token to a participant", async () => {
    const wallet = Wallet.createRandom();
    const { json } = await makeRoom({ creator: wallet.address });

    const claim = await signSession(wallet, json.room.room_code);
    const res = await sessionRoute(
      jsonRequest("http://localhost/session", claim),
      params(json.room.room_code)
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.side).toBe("creator");

    const session = verifySessionToken(body.token);
    expect(session.roomId).toBe(json.room.id);
    expect(session.address).toBe(wallet.address.toLowerCase());
  });

  it("rejects a session signed by a different wallet", async () => {
    const owner = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const { json } = await makeRoom({ creator: owner.address });

    const payload = {
      address: owner.address,
      roomCode: json.room.room_code,
      issuedAt: new Date().toISOString(),
      nonce: randHex(32),
    };
    const signature = await attacker.signMessage(buildSessionMessage(payload));

    const res = await sessionRoute(
      jsonRequest("http://localhost/session", { ...payload, signature }),
      params(json.room.room_code)
    );
    expect(res.status).toBe(401);
  });

  it("refuses a session to someone not in the duel", async () => {
    const outsider = Wallet.createRandom();
    const { json } = await makeRoom();

    const claim = await signSession(outsider, json.room.room_code);
    const res = await sessionRoute(
      jsonRequest("http://localhost/session", claim),
      params(json.room.room_code)
    );
    expect(res.status).toBe(403);
  });

  it("rejects a stale session signature", async () => {
    const wallet = Wallet.createRandom();
    const { json } = await makeRoom({ creator: wallet.address });

    const claim = await signSession(wallet, json.room.room_code, {
      issuedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    const res = await sessionRoute(
      jsonRequest("http://localhost/session", claim),
      params(json.room.room_code)
    );
    expect(res.status).toBe(400);
  });

  it("binds a session signature to its room", async () => {
    const wallet = Wallet.createRandom();
    const roomA = await makeRoom({ creator: wallet.address });
    const roomB = await makeRoom({ creator: wallet.address });

    // Signature names room A but is presented at room B.
    const claim = await signSession(wallet, roomA.json.room.room_code);
    const res = await sessionRoute(
      jsonRequest("http://localhost/session", claim),
      params(roomB.json.room.room_code)
    );
    expect(res.status).toBe(401);
  });
});
