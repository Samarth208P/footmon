import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The in-memory fallback must remain usable for local dev, but it must never be
 * silent: the previous implementation swallowed Supabase failures and quietly
 * lost duel state, which makes escrowed stakes look stuck for no visible reason.
 */

describe("duel store in-memory fallback", () => {
  let store;
  let errorSpy;
  let warnSpy;

  beforeAll(async () => {
    // Simulate an unconfigured deployment.
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;

    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.resetModules();
    store = await import("@/lib/duel-store");
    store.__resetMemoryStore();
  });

  it("shouts a banner on first fallback use instead of failing silently", async () => {
    await store.createRoom({
      duelId: `0x${"a".repeat(64)}`,
      roomCode: "MEM001",
      creator: "0x1111111111111111111111111111111111111111",
      stake: "1000",
    });

    const banner = errorSpy.mock.calls.flat().join("\n");
    expect(banner).toMatch(/IN[- ]MEMORY|NOT PERSISTED|NOT CONFIGURED/i);

    // And every individual write is warned about, not just the first.
    expect(warnSpy.mock.calls.flat().join("\n")).toMatch(/not persisted/i);
  });

  it("round-trips a full duel through memory", async () => {
    store.__resetMemoryStore();

    const creator = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const joiner = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    const room = await store.createRoom({
      duelId: `0x${"b".repeat(64)}`,
      roomCode: "MEM002",
      creator,
      stake: "50000000000000000",
    });
    expect(room.status).toBe("open");

    const joined = await store.joinRoom(room.id, joiner);
    expect(joined.joiner).toBe(joiner);
    expect(joined.status).toBe("full");

    // Second joiner loses the race.
    expect(await store.joinRoom(room.id, "0xcccccccccccccccccccccccccccccccccccccccc")).toBeNull();

    const squad = await store.upsertSquad({
      roomId: room.id,
      player: creator,
      nation: "BRA",
      year: 1970,
      formation: "4-3-3",
    });

    await store.pickSlot({
      squadId: squad.id,
      slotIndex: 0,
      slotPos: "GK",
      playerName: "Felix",
    });

    const slots = await store.listSquadSlots(squad.id);
    expect(slots).toHaveLength(1);

    await store.appendMatchLog({ roomId: room.id, seq: 0, minute: 0, eventType: "kickoff" });
    await store.appendMatchLog({
      roomId: room.id,
      seq: 1,
      minute: 10,
      eventType: "goal",
      team: "creator",
      scorerName: "Pele",
      scoreCreator: 1,
    });

    const logs = await store.listMatchLogs(room.id);
    expect(logs.map((l) => l.seq)).toEqual([0, 1]);
    expect(await store.listMatchLogs(room.id, 0)).toHaveLength(1);
  });

  it("mirrors the database uniqueness guarantees", async () => {
    store.__resetMemoryStore();

    const room = await store.createRoom({
      duelId: `0x${"c".repeat(64)}`,
      roomCode: "MEM003",
      creator: "0xdddddddddddddddddddddddddddddddddddddddd",
      stake: "1000",
    });
    const squad = await store.upsertSquad({
      roomId: room.id,
      player: "0xdddddddddddddddddddddddddddddddddddddddd",
    });

    await store.pickSlot({ squadId: squad.id, slotIndex: 3, slotPos: "CB", playerName: "Brito" });

    // Same slot twice.
    await expect(
      store.pickSlot({ squadId: squad.id, slotIndex: 3, slotPos: "CB", playerName: "Other" })
    ).rejects.toThrow();

    // Same footballer twice.
    await expect(
      store.pickSlot({ squadId: squad.id, slotIndex: 4, slotPos: "CB", playerName: "Brito" })
    ).rejects.toThrow();

    await store.appendMatchLog({ roomId: room.id, seq: 0, minute: 0, eventType: "kickoff" });
    await expect(
      store.appendMatchLog({ roomId: room.id, seq: 0, minute: 1, eventType: "chance" })
    ).rejects.toThrow();
  });

  it("keeps private rooms out of the lobby and normalises address casing", async () => {
    store.__resetMemoryStore();

    await store.createRoom({
      duelId: `0x${"d".repeat(64)}`,
      roomCode: "MEMPRV",
      creator: "0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
      stake: "1000",
      isPrivate: true,
      passwordHash: "scrypt$x",
    });
    await store.createRoom({
      duelId: `0x${"e".repeat(64)}`,
      roomCode: "MEMPUB",
      creator: "0xffffffffffffffffffffffffffffffffffffffff",
      stake: "1000",
      isPrivate: false,
    });

    const lobby = await store.listOpenRooms();
    const codes = lobby.map((r) => r.room_code);
    expect(codes).toContain("MEMPUB");
    expect(codes).not.toContain("MEMPRV");

    // Checksummed input is stored lowercase.
    const priv = await store.getRoomByCode("MEMPRV");
    expect(priv.creator).toBe("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  });
});
