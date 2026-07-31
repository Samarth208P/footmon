import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

import {
  appendMatchLog,
  createRoom,
  getRoomByCode,
  getRoomByDuelId,
  getRoomPasswordHash,
  getSquad,
  joinRoom,
  listDuelLeaderboard,
  listMatchLogs,
  listOpenRooms,
  listSquadSlots,
  listTournamentLeaderboard,
  pickSlot,
  recordDuelResult,
  recordTournamentRun,
  updateRoom,
  upsertProfile,
  upsertSquad,
} from "@/lib/duel-store";

/**
 * Integration test for the duel store against the real Supabase project.
 *
 * Skips loudly rather than silently passing when Supabase is unconfigured —
 * a green suite must never imply persistence that was not exercised.
 */

const configured = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
);

if (!configured) {
  console.error(
    "\n[duel-store.test] SKIPPED: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY " +
      "are not set, so durable storage was NOT verified.\n"
  );
}

const rand = (n) =>
  Array.from({ length: n }, () =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".charAt(Math.floor(Math.random() * 36))
  ).join("");

const randHex = (n) =>
  Array.from({ length: n }, () => "0123456789abcdef".charAt(Math.floor(Math.random() * 16))).join("");

const testAddr = () => `0x${randHex(40)}`;

describe.skipIf(!configured)("duel store (Supabase integration)", () => {
  const admin = configured
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

  const creator = testAddr();
  const joiner = testAddr();
  const outsider = testAddr();
  const duelId = `0x${randHex(64)}`;
  const roomCode = rand(8);

  let room;
  let squad;

  // Track what we create so the project is left clean.
  const createdRoomIds = [];
  const createdAddresses = [creator, joiner, outsider];

  afterAll(async () => {
    if (!admin) return;
    // duel_squads / duel_squad_slots / match_logs / duel_room_secrets all
    // cascade from duel_rooms.
    for (const id of createdRoomIds) {
      await admin.from("duel_rooms").delete().eq("id", id);
    }
    for (const a of createdAddresses) {
      await admin.from("duel_leaderboard").delete().eq("address", a);
      await admin.from("tournament_leaderboard").delete().eq("address", a);
      await admin.from("profiles").delete().eq("address", a);
    }
  });

  it("creates a room and reads it back by code and by duel id", async () => {
    room = await createRoom({
      duelId,
      roomCode,
      creator,
      stake: "50000000000000000", // 0.05 MON in wei
      isPrivate: true,
      passwordHash: "scrypt$test$hash",
      draftSeed: "seed-draft-1",
      matchSeed: "seed-match-1",
    });
    createdRoomIds.push(room.id);

    expect(room.id).toBeTruthy();
    expect(room.status).toBe("open");
    expect(room.creator).toBe(creator);
    expect(room.joiner).toBeNull();

    const byCode = await getRoomByCode(roomCode);
    expect(byCode.id).toBe(room.id);

    const byDuelId = await getRoomByDuelId(duelId);
    expect(byDuelId.id).toBe(room.id);

    // Stake is a 78-digit numeric; it must survive as an exact integer string.
    expect(String(byCode.stake)).toBe("50000000000000000");
  });

  it("stores the room password in a table the browser cannot read", async () => {
    const hash = await getRoomPasswordHash(room.id);
    expect(hash).toBe("scrypt$test$hash");

    // The hash must not be reachable through the room record itself.
    expect(room.password_hash).toBeUndefined();
    const fetched = await getRoomByCode(roomCode);
    expect(fetched.password_hash).toBeUndefined();
  });

  it("keeps private rooms out of the public lobby", async () => {
    const open = await listOpenRooms();
    expect(open.some((r) => r.room_code === roomCode)).toBe(false);
  });

  it("lists a public room in the lobby", async () => {
    const publicCode = rand(8);
    const publicRoom = await createRoom({
      duelId: `0x${randHex(64)}`,
      roomCode: publicCode,
      creator: testAddr(),
      stake: "10000000000000000",
      isPrivate: false,
    });
    createdRoomIds.push(publicRoom.id);

    const open = await listOpenRooms();
    expect(open.some((r) => r.room_code === publicCode)).toBe(true);
  });

  it("joins the room atomically and rejects a second joiner", async () => {
    const joined = await joinRoom(room.id, joiner);
    expect(joined).not.toBeNull();
    expect(joined.joiner).toBe(joiner);
    expect(joined.status).toBe("full");

    // Room is no longer 'open', so a late joiner matches zero rows.
    const second = await joinRoom(room.id, outsider);
    expect(second).toBeNull();
  });

  it("refuses a self-join", async () => {
    const selfCode = rand(8);
    const selfRoom = await createRoom({
      duelId: `0x${randHex(64)}`,
      roomCode: selfCode,
      creator,
      stake: "10000000000000000",
    });
    createdRoomIds.push(selfRoom.id);

    const result = await joinRoom(selfRoom.id, creator);
    expect(result).toBeNull();
  });

  it("writes a squad and reads it back", async () => {
    squad = await upsertSquad({
      roomId: room.id,
      player: creator,
      nation: "BRA",
      year: 1970,
      formation: "4-3-3",
      style: "attacking",
    });

    expect(squad.id).toBeTruthy();
    expect(squad.nation).toBe("BRA");
    expect(squad.year).toBe(1970);

    const fetched = await getSquad(room.id, creator);
    expect(fetched.id).toBe(squad.id);
    expect(fetched.formation).toBe("4-3-3");
  });

  it("upserts the same squad without creating a duplicate", async () => {
    const again = await upsertSquad({
      roomId: room.id,
      player: creator,
      nation: "BRA",
      year: 1970,
      formation: "4-4-2",
      style: "balanced",
    });
    expect(again.id).toBe(squad.id);
    expect(again.formation).toBe("4-4-2");
  });

  it("records draft picks in slot order", async () => {
    await pickSlot({
      squadId: squad.id,
      slotIndex: 0,
      slotPos: "GK",
      playerName: "Felix",
      playerPosition: "GK",
      playerRating: 78.5,
    });
    await pickSlot({
      squadId: squad.id,
      slotIndex: 1,
      slotPos: "CB",
      playerName: "Brito",
      playerPosition: "CB",
      playerRating: 80,
    });

    const slots = await listSquadSlots(squad.id);
    expect(slots).toHaveLength(2);
    expect(slots[0].slot_index).toBe(0);
    expect(slots[0].player_name).toBe("Felix");
    expect(slots[1].player_name).toBe("Brito");
    expect(Number(slots[0].player_rating)).toBeCloseTo(78.5, 2);
  });

  it("rejects reusing a slot index", async () => {
    await expect(
      pickSlot({ squadId: squad.id, slotIndex: 0, slotPos: "GK", playerName: "Someone" })
    ).rejects.toThrow();
  });

  it("rejects picking the same footballer twice", async () => {
    await expect(
      pickSlot({ squadId: squad.id, slotIndex: 5, slotPos: "CB", playerName: "Brito" })
    ).rejects.toThrow();
  });

  it("appends match log ticks and replays them in order", async () => {
    await appendMatchLog({
      roomId: room.id,
      seq: 0,
      minute: 0,
      eventType: "kickoff",
    });
    await appendMatchLog({
      roomId: room.id,
      seq: 1,
      minute: 23,
      eventType: "goal",
      team: "creator",
      scorerName: "Pele",
      scoreCreator: 1,
      scoreJoiner: 0,
    });
    await appendMatchLog({
      roomId: room.id,
      seq: 2,
      minute: 90,
      eventType: "full_time",
      scoreCreator: 1,
      scoreJoiner: 0,
    });

    const logs = await listMatchLogs(room.id);
    expect(logs.map((l) => l.seq)).toEqual([0, 1, 2]);
    expect(logs[1].event_type).toBe("goal");
    expect(logs[1].scorer_name).toBe("Pele");

    // Reconnect path: only fetch what was missed.
    const missed = await listMatchLogs(room.id, 0);
    expect(missed.map((l) => l.seq)).toEqual([1, 2]);
  });

  it("rejects a duplicate match log seq so retries cannot double-count goals", async () => {
    await expect(
      appendMatchLog({ roomId: room.id, seq: 1, minute: 40, eventType: "chance" })
    ).rejects.toThrow();
  });

  it("refuses to attribute a scorer to a non-goal event", async () => {
    await expect(
      appendMatchLog({
        roomId: room.id,
        seq: 99,
        minute: 40,
        eventType: "save",
        scorerName: "Not A Goal",
      })
    ).rejects.toThrow();
  });

  it("updates room state for resolution", async () => {
    const updated = await updateRoom(room.id, {
      status: "complete",
      score_creator: 1,
      score_joiner: 0,
      winner: creator,
      resolver_tx: "0x" + randHex(64),
      resolved_at: new Date().toISOString(),
    });

    expect(updated.status).toBe("complete");
    expect(updated.winner).toBe(creator);
    expect(updated.score_creator).toBe(1);
  });

  it("rejects a winner who never played in the room", async () => {
    await expect(updateRoom(room.id, { winner: outsider })).rejects.toThrow();
  });

  it("accumulates the duel leaderboard", async () => {
    await upsertProfile({ address: creator, username: `U${rand(6)}` });

    await recordDuelResult({
      address: creator,
      won: true,
      goalsFor: 3,
      goalsAgainst: 1,
      monWon: "70000000000000000",
    });
    await recordDuelResult({
      address: creator,
      won: true,
      goalsFor: 2,
      goalsAgainst: 0,
      monWon: "70000000000000000",
    });

    const board = await listDuelLeaderboard(100);
    const row = board.find((r) => r.address === creator);
    expect(row).toBeTruthy();
    expect(row.wins).toBe(2);
    expect(row.goals_for).toBe(5);
    expect(row.goal_diff).toBe(4);
    // Wei accumulates exactly, without float drift.
    expect(String(row.mon_won)).toBe("140000000000000000");
  });

  it("ranks the tournament leaderboard by wins, then goal diff, then rating", async () => {
    await recordTournamentRun({
      address: creator,
      wins: 7,
      goalsFor: 14,
      goalsAgainst: 3,
      teamRating: 84.5,
      nation: "BRA",
      year: 1970,
      formation: "4-3-3",
    });
    await recordTournamentRun({
      address: joiner,
      wins: 7,
      goalsFor: 14,
      goalsAgainst: 8,
      teamRating: 88.0,
      nation: "ITA",
      year: 1982,
      formation: "4-4-2",
    });
    await recordTournamentRun({
      address: outsider,
      wins: 3,
      goalsFor: 5,
      goalsAgainst: 5,
      teamRating: 90.0,
      nation: "ARG",
      year: 1986,
      formation: "4-3-3",
    });

    const board = await listTournamentLeaderboard(100);
    const mine = board.filter((r) =>
      [creator, joiner, outsider].includes(r.address)
    );

    // Equal wins → better goal difference wins, even with a lower rating.
    const creatorRank = mine.find((r) => r.address === creator).rank;
    const joinerRank = mine.find((r) => r.address === joiner).rank;
    const outsiderRank = mine.find((r) => r.address === outsider).rank;

    expect(creatorRank).toBeLessThan(joinerRank);
    // Fewer wins loses regardless of the highest rating in the set.
    expect(joinerRank).toBeLessThan(outsiderRank);
  });

  it("normalises checksummed addresses to lowercase", async () => {
    const mixed = creator.toUpperCase().replace("0X", "0x");
    const found = await getSquad(room.id, mixed);
    expect(found).not.toBeNull();
    expect(found.player).toBe(creator);
  });
});
