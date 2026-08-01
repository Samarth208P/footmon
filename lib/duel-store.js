import {
  PUBLISHABLE_KEY_WRITE_ERROR,
  describeProjectHost,
  getServerClient,
  isPublishableKeyInSecretSlot,
  isSupabaseConfigured,
} from "@/lib/supabase-server";

/**
 * Durable, reconnect-safe state for duels.
 *
 * Every function here works against Supabase when configured. When it is not,
 * an in-memory fallback keeps local development usable — but it announces
 * itself LOUDLY on first use and warns on every write, because silently losing
 * duel state (as the previous implementation did) hides real misconfiguration
 * and makes escrowed stakes look stuck.
 */

// ── In-memory fallback ──────────────────────────────────────────────────────

const memory = (globalThis.__footmonMemory ??= {
  rooms: [],
  secrets: new Map(),
  squads: [],
  slots: [],
  matchLogs: [],
  profiles: [],
  duelLeaderboard: [],
  tournamentRuns: [],
  challenges: [],
  events: [],
  nextId: 1,
});

let fallbackBannerShown = false;

function fallbackWarn(operation) {
  if (!fallbackBannerShown) {
    fallbackBannerShown = true;
    console.error(
      "\n" +
        "##############################################################\n" +
        "# FootMon: DUEL STORE IS RUNNING IN MEMORY (NOT PERSISTED)   #\n" +
        "#------------------------------------------------------------#\n" +
        "# Rooms, squads, match logs and leaderboards live only in    #\n" +
        "# this process. They vanish on restart and are invisible to  #\n" +
        "# other devices or serverless instances.                     #\n" +
        "#                                                            #\n" +
        "# This is DEV-ONLY behaviour. Configure Supabase before any   #\n" +
        "# multi-device or staked play.                                #\n" +
        "##############################################################\n"
    );
  }
  console.warn(`[FootMon][in-memory] ${operation} — not persisted`);
}

function nextId() {
  return memory.nextId++;
}

function nowIso() {
  return new Date().toISOString();
}

/** Normalises addresses so lookups never miss on checksum casing. */
function addr(value) {
  if (typeof value !== "string") return value;
  return value.toLowerCase();
}

/**
 * Turns a Supabase error into a thrown Error. We never swallow these: a failed
 * write must surface, not silently degrade mid-match.
 */
function unwrap(result, context) {
  const { data, error } = result;
  if (error) {
    // A publishable key has SELECT but no write grants, so writes come back as
    // permission/RLS failures. Say why, rather than leaving a bare 42501.
    const permissionDenied =
      error.code === "42501" ||
      /permission denied|row-level security|violates row-level/i.test(error.message ?? "");

    // PGRST205 = the table is not in PostgREST's schema cache, i.e. the project
    // the SERVER is talking to has no FootMon tables. Almost always SUPABASE_URL
    // pointing at a different project than the one migrations were run against.
    const schemaMissing =
      error.code === "PGRST205" || /Could not find the table/i.test(error.message ?? "");

    let detail = error.message;
    if (permissionDenied && isPublishableKeyInSecretSlot()) {
      detail = `${error.message} — ${PUBLISHABLE_KEY_WRITE_ERROR}`;
    } else if (schemaMissing) {
      detail =
        `${error.message} — the server is connected to ${describeProjectHost()}, ` +
        `which has no FootMon tables. Check that SUPABASE_URL matches the project ` +
        `you ran migrations against (it must match NEXT_PUBLIC_SUPABASE_URL), then ` +
        `run \`npm run db:push\`.`;
    }

    const err = new Error(`[duel-store] ${context}: ${detail}`);
    err.code = error.code;
    err.details = error.details;
    err.hint = error.hint;
    throw err;
  }
  return data;
}

function usingSupabase() {
  return isSupabaseConfigured() && getServerClient() !== null;
}

// ── Profiles ────────────────────────────────────────────────────────────────

export async function getProfile(address) {
  const key = addr(address);
  if (!usingSupabase()) {
    fallbackWarn("getProfile");
    return memory.profiles.find((p) => p.address === key) || null;
  }
  const data = unwrap(
    await getServerClient()
      .from("profiles")
      .select("address, username, created_at, updated_at, username_updated_at")
      .eq("address", key)
      .maybeSingle(),
    "getProfile"
  );
  return data || null;
}

/** Batch lookup so a lobby or leaderboard resolves names in one round trip. */
export async function getProfiles(addresses) {
  const keys = [...new Set((addresses ?? []).map(addr).filter(Boolean))];
  if (keys.length === 0) return [];

  if (!usingSupabase()) {
    fallbackWarn("getProfiles");
    return memory.profiles.filter((p) => keys.includes(p.address));
  }
  return unwrap(
    await getServerClient()
      .from("profiles")
      .select("address, username")
      .in("address", keys),
    "getProfiles"
  );
}

export async function getProfileByUsername(username) {  if (!usingSupabase()) {
    fallbackWarn("getProfileByUsername");
    const lower = String(username).toLowerCase();
    return memory.profiles.find((p) => p.username.toLowerCase() === lower) || null;
  }
  // ilike with no wildcards is an exact, case-insensitive match.
  const data = unwrap(
    await getServerClient()
      .from("profiles")
      .select("address, username, username_updated_at")
      .ilike("username", username)
      .maybeSingle(),
    "getProfileByUsername"
  );
  return data || null;
}

export async function upsertProfile({ address, username }) {
  const key = addr(address);
  const row = {
    address: key,
    username,
    username_updated_at: nowIso(),
    updated_at: nowIso(),
  };

  if (!usingSupabase()) {
    fallbackWarn("upsertProfile");
    const idx = memory.profiles.findIndex((p) => p.address === key);
    if (idx === -1) {
      memory.profiles.push({ ...row, created_at: nowIso() });
    } else {
      memory.profiles[idx] = { ...memory.profiles[idx], ...row };
    }
    return memory.profiles.find((p) => p.address === key);
  }

  const data = unwrap(
    await getServerClient()
      .from("profiles")
      .upsert(row, { onConflict: "address" })
      .select()
      .single(),
    "upsertProfile"
  );
  return data;
}

// ── Rooms ───────────────────────────────────────────────────────────────────

export async function createRoom({
  duelId,
  roomCode,
  creator,
  stake,
  isPrivate = false,
  passwordHash = null,
  draftSeed = null,
  matchSeed = null,
}) {
  const row = {
    duel_id: duelId,
    room_code: roomCode,
    creator: addr(creator),
    stake: String(stake),
    is_private: Boolean(isPrivate),
    status: "open",
    draft_seed: draftSeed,
    match_seed: matchSeed,
  };

  if (!usingSupabase()) {
    fallbackWarn("createRoom");
    const room = {
      id: `mem-${nextId()}`,
      ...row,
      joiner: null,
      creator_ready: false,
      joiner_ready: false,
      score_creator: 0,
      score_joiner: 0,
      winner: null,
      is_draw: false,
      resolver_tx: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    memory.rooms.push(room);
    if (passwordHash) memory.secrets.set(room.id, passwordHash);
    return room;
  }

  const room = unwrap(
    await getServerClient().from("duel_rooms").insert(row).select().single(),
    "createRoom"
  );

  if (passwordHash) {
    unwrap(
      await getServerClient()
        .from("duel_room_secrets")
        .upsert({ room_id: room.id, password_hash: passwordHash }, { onConflict: "room_id" })
        .select("room_id"),
      "createRoom:secret"
    );
  }

  return room;
}

const ROOM_COLUMNS =
  "id, duel_id, room_code, creator, joiner, stake, is_private, status, " +
  "creator_ready, joiner_ready, ready_deadline, current_turn, turn_deadline, " +
  "draft_seed, match_seed, score_creator, score_joiner, winner, is_draw, " +
  "resolver_tx, resolved_at, created_at, updated_at";

async function findRoomBy(column, value) {
  if (!usingSupabase()) {
    fallbackWarn(`getRoomBy:${column}`);
    return memory.rooms.find((r) => r[column] === value) || null;
  }
  const data = unwrap(
    await getServerClient()
      .from("duel_rooms")
      .select(ROOM_COLUMNS)
      .eq(column, value)
      .maybeSingle(),
    `getRoomBy:${column}`
  );
  return data || null;
}

export const getRoomById     = (id)   => findRoomBy("id", id);
export const getRoomByCode   = (code) => findRoomBy("room_code", code);
export const getRoomByDuelId = (dId)  => findRoomBy("duel_id", dId);

/** Public lobby only: private rooms stay unlisted. */
export async function listOpenRooms() {
  if (!usingSupabase()) {
    fallbackWarn("listOpenRooms");
    return memory.rooms
      .filter((r) => !r.is_private && r.status === "open" && !r.joiner)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  return unwrap(
    await getServerClient()
      .from("duel_lobby")
      .select("id, duel_id, room_code, creator, stake, status, created_at, creator_username"),
    "listOpenRooms"
  );
}

/**
 * Atomically claims the open room for `joiner`.
 *
 * The status/joiner predicates are part of the UPDATE, so two players racing
 * to join the same room cannot both succeed — the loser matches zero rows.
 */
export async function joinRoom(roomId, joiner) {
  const key = addr(joiner);

  if (!usingSupabase()) {
    fallbackWarn("joinRoom");
    const room = memory.rooms.find((r) => r.id === roomId);
    if (!room || room.status !== "open" || room.joiner) return null;
    if (room.creator === key) return null;
    room.joiner = key;
    room.status = "full";
    room.updated_at = nowIso();
    return room;
  }

  const rows = unwrap(
    await getServerClient()
      .from("duel_rooms")
      .update({ joiner: key, status: "full" })
      .eq("id", roomId)
      .eq("status", "open")
      .is("joiner", null)
      .neq("creator", key)
      .select(ROOM_COLUMNS),
    "joinRoom"
  );
  return rows?.[0] || null;
}

export async function updateRoom(roomId, patch) {
  if (!usingSupabase()) {
    fallbackWarn("updateRoom");
    const room = memory.rooms.find((r) => r.id === roomId);
    if (!room) return null;
    Object.assign(room, patch, { updated_at: nowIso() });
    return room;
  }
  const rows = unwrap(
    await getServerClient()
      .from("duel_rooms")
      .update(patch)
      .eq("id", roomId)
      .select(ROOM_COLUMNS),
    "updateRoom"
  );
  return rows?.[0] || null;
}

/** Server-only: never expose the hash to a response body. */
export async function getRoomPasswordHash(roomId) {
  if (!usingSupabase()) {
    fallbackWarn("getRoomPasswordHash");
    return memory.secrets.get(roomId) || null;
  }
  const data = unwrap(
    await getServerClient()
      .from("duel_room_secrets")
      .select("password_hash")
      .eq("room_id", roomId)
      .maybeSingle(),
    "getRoomPasswordHash"
  );
  return data?.password_hash || null;
}

// ── Squads ──────────────────────────────────────────────────────────────────

export async function upsertSquad({
  roomId,
  player,
  nation = null,
  year = null,
  formation = null,
  style = null,
  avgRating = null,
  isComplete = false,
}) {
  const row = {
    room_id: roomId,
    player: addr(player),
    nation,
    year,
    formation,
    style,
    avg_rating: avgRating,
    is_complete: isComplete,
  };

  if (!usingSupabase()) {
    fallbackWarn("upsertSquad");
    const existing = memory.squads.find(
      (s) => s.room_id === roomId && s.player === row.player
    );
    if (existing) {
      Object.assign(existing, row, { updated_at: nowIso() });
      return existing;
    }
    const squad = { id: nextId(), ...row, created_at: nowIso(), updated_at: nowIso() };
    memory.squads.push(squad);
    return squad;
  }

  return unwrap(
    await getServerClient()
      .from("duel_squads")
      .upsert(row, { onConflict: "room_id,player" })
      .select()
      .single(),
    "upsertSquad"
  );
}

export async function getSquad(roomId, player) {
  const key = addr(player);
  if (!usingSupabase()) {
    fallbackWarn("getSquad");
    return memory.squads.find((s) => s.room_id === roomId && s.player === key) || null;
  }
  const data = unwrap(
    await getServerClient()
      .from("duel_squads")
      .select("*")
      .eq("room_id", roomId)
      .eq("player", key)
      .maybeSingle(),
    "getSquad"
  );
  return data || null;
}

export async function listSquads(roomId) {
  if (!usingSupabase()) {
    fallbackWarn("listSquads");
    return memory.squads.filter((s) => s.room_id === roomId);
  }
  return unwrap(
    await getServerClient().from("duel_squads").select("*").eq("room_id", roomId),
    "listSquads"
  );
}

/**
 * Records one draft pick. Unique constraints on (squad_id, slot_index) and
 * (squad_id, player_name) mean a duplicate pick raises instead of corrupting
 * the squad, so out-of-order retries are safe.
 *
 * `playerNation` and `playerYear` capture the wheel outcome at the moment
 * the pick was made. They feed the hidden chemistry system (same-nation
 * and same-year cores) at simulation time. They are optional so the
 * function is safe to call before the migration adds those columns —
 * on a permission/column error we retry without them.
 */
export async function pickSlot({
  squadId,
  slotIndex,
  slotPos,
  playerName,
  playerPosition = null,
  playerRating = null,
  playerNation = null,
  playerYear = null,
}) {
  const baseRow = {
    squad_id: squadId,
    slot_index: slotIndex,
    slot_pos: slotPos,
    player_name: playerName,
    player_position: playerPosition,
    player_rating: playerRating,
  };
  const extras = {
    player_nation: playerNation,
    player_year: playerYear,
  };

  if (!usingSupabase()) {
    fallbackWarn("pickSlot");
    const clash = memory.slots.find(
      (s) =>
        s.squad_id === squadId &&
        (s.slot_index === slotIndex || s.player_name === playerName)
    );
    if (clash) throw new Error("[duel-store] pickSlot: slot or player already used");
    const slot = { id: nextId(), ...baseRow, ...extras, picked_at: nowIso() };
    memory.slots.push(slot);
    return slot;
  }

  const client = getServerClient();

  // Try the full row first; fall back to the base row if the table doesn't
  // have the chemistry columns yet. This keeps the API working before the
  // migration lands without losing data once it does.
  try {
    return unwrap(
      await client.from("duel_squad_slots").insert({ ...baseRow, ...extras }).select().single(),
      "pickSlot"
    );
  } catch (err) {
    const missingColumn =
      err?.code === "PGRST204" ||
      err?.code === "42703" ||
      /player_nation|player_year|column .* does not exist/i.test(err?.message ?? "");
    if (!missingColumn) throw err;
    return unwrap(
      await client.from("duel_squad_slots").insert(baseRow).select().single(),
      "pickSlot"
    );
  }
}

export async function listSquadSlots(squadId) {
  if (!usingSupabase()) {
    fallbackWarn("listSquadSlots");
    return memory.slots
      .filter((s) => s.squad_id === squadId)
      .sort((a, b) => a.slot_index - b.slot_index);
  }
  return unwrap(
    await getServerClient()
      .from("duel_squad_slots")
      .select("*")
      .eq("squad_id", squadId)
      .order("slot_index", { ascending: true }),
    "listSquadSlots"
  );
}

// ── Match logs ──────────────────────────────────────────────────────────────

export async function appendMatchLog({
  roomId,
  mode = "duel",
  seq,
  minute,
  eventType,
  team = null,
  scorerName = null,
  scoreCreator = 0,
  scoreJoiner = 0,
  payload = {},
}) {
  const row = {
    room_id: roomId,
    mode,
    seq,
    minute,
    event_type: eventType,
    team,
    scorer_name: scorerName,
    score_creator: scoreCreator,
    score_joiner: scoreJoiner,
    payload,
  };

  if (!usingSupabase()) {
    fallbackWarn("appendMatchLog");
    if (memory.matchLogs.some((l) => l.room_id === roomId && l.seq === seq)) {
      throw new Error("[duel-store] appendMatchLog: duplicate seq");
    }
    const log = { id: nextId(), ...row, created_at: nowIso() };
    memory.matchLogs.push(log);
    return log;
  }

  return unwrap(
    await getServerClient().from("match_logs").insert(row).select().single(),
    "appendMatchLog"
  );
}

export async function listMatchLogs(roomId, afterSeq = -1) {
  if (!usingSupabase()) {
    fallbackWarn("listMatchLogs");
    return memory.matchLogs
      .filter((l) => l.room_id === roomId && l.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq);
  }
  return unwrap(
    await getServerClient()
      .from("match_logs")
      .select("*")
      .eq("room_id", roomId)
      .gt("seq", afterSeq)
      .order("seq", { ascending: true }),
    "listMatchLogs"
  );
}

// ── Leaderboards ────────────────────────────────────────────────────────────

export async function recordDuelResult({
  address,
  won = false,
  drew = false,
  goalsFor = 0,
  goalsAgainst = 0,
  monWon = "0",
}) {
  const key = addr(address);
  const existing = await getDuelLeaderboardRow(key);

  const next = {
    address: key,
    wins:          (existing?.wins   ?? 0) + (won ? 1 : 0),
    losses:        (existing?.losses ?? 0) + (!won && !drew ? 1 : 0),
    draws:         (existing?.draws  ?? 0) + (drew ? 1 : 0),
    goals_for:     (existing?.goals_for     ?? 0) + goalsFor,
    goals_against: (existing?.goals_against ?? 0) + goalsAgainst,
    mon_won: String(BigInt(existing?.mon_won ?? "0") + BigInt(monWon)),
    updated_at: nowIso(),
  };

  if (!usingSupabase()) {
    fallbackWarn("recordDuelResult");
    const idx = memory.duelLeaderboard.findIndex((r) => r.address === key);
    if (idx === -1) memory.duelLeaderboard.push(next);
    else memory.duelLeaderboard[idx] = next;
    return next;
  }

  return unwrap(
    await getServerClient()
      .from("duel_leaderboard")
      .upsert(next, { onConflict: "address" })
      .select()
      .single(),
    "recordDuelResult"
  );
}

async function getDuelLeaderboardRow(address) {
  const key = addr(address);
  if (!usingSupabase()) {
    return memory.duelLeaderboard.find((r) => r.address === key) || null;
  }
  const data = unwrap(
    await getServerClient()
      .from("duel_leaderboard")
      .select("*")
      .eq("address", key)
      .maybeSingle(),
    "getDuelLeaderboardRow"
  );
  return data || null;
}

export async function listDuelLeaderboard(limit = 50) {
  if (!usingSupabase()) {
    fallbackWarn("listDuelLeaderboard");
    return [...memory.duelLeaderboard]
      .sort(
        (a, b) =>
          b.wins - a.wins ||
          b.goals_for - b.goals_against - (a.goals_for - a.goals_against) ||
          a.address.localeCompare(b.address)
      )
      .slice(0, limit);
  }
  return unwrap(
    await getServerClient()
      .from("duel_leaderboard_ranked")
      .select("*")
      .order("rank", { ascending: true })
      .limit(limit),
    "listDuelLeaderboard"
  );
}

export async function recordTournamentRun({
  address,
  wins,
  goalsFor = 0,
  goalsAgainst = 0,
  teamRating,
  nation = null,
  year = null,
  formation = null,
  runSeed = null,
}) {
  const row = {
    address: addr(address),
    wins,
    goals_for: goalsFor,
    goals_against: goalsAgainst,
    goal_diff: goalsFor - goalsAgainst,
    team_rating: teamRating,
    nation,
    year,
    formation,
    run_seed: runSeed,
  };

  if (!usingSupabase()) {
    fallbackWarn("recordTournamentRun");
    const run = { id: nextId(), ...row, completed_at: nowIso() };
    memory.tournamentRuns.push(run);
    return run;
  }

  return unwrap(
    await getServerClient().from("tournament_leaderboard").insert(row).select().single(),
    "recordTournamentRun"
  );
}

/** Ranked wins → goal difference → team rating. */
export async function listTournamentLeaderboard(limit = 50) {
  if (!usingSupabase()) {
    fallbackWarn("listTournamentLeaderboard");
    return [...memory.tournamentRuns]
      .sort(
        (a, b) =>
          b.wins - a.wins ||
          b.goal_diff - a.goal_diff ||
          Number(b.team_rating) - Number(a.team_rating) ||
          a.completed_at.localeCompare(b.completed_at)
      )
      .slice(0, limit);
  }
  return unwrap(
    await getServerClient()
      .from("tournament_leaderboard_ranked")
      .select("*")
      .order("rank", { ascending: true })
      .limit(limit),
    "listTournamentLeaderboard"
  );
}

// ── Legacy challenge/event API ──────────────────────────────────────────────
// Kept so the existing routes keep working until Task 8 moves them over.

export async function listOpenChallenges() {
  if (!usingSupabase()) {
    fallbackWarn("listOpenChallenges");
    return memory.challenges.filter((c) => c.status === "open");
  }
  return unwrap(
    await getServerClient()
      .from("duel_challenges")
      .select("duel_id, creator, joiner, stake, session_pub_key, status, created_at, updated_at")
      .eq("status", "open")
      .order("created_at", { ascending: false }),
    "listOpenChallenges"
  );
}

export async function getChallenge(duelId) {
  if (!usingSupabase()) {
    fallbackWarn("getChallenge");
    return memory.challenges.find((c) => c.duel_id === duelId) || null;
  }
  const data = unwrap(
    await getServerClient()
      .from("duel_challenges")
      .select("duel_id, creator, joiner, stake, session_pub_key, status, created_at, updated_at")
      .eq("duel_id", duelId)
      .maybeSingle(),
    "getChallenge"
  );
  return data || null;
}

export async function createChallenge(challenge) {
  const row = {
    duel_id: challenge.duelId,
    creator: challenge.creator,
    stake: challenge.stake,
    session_pub_key: challenge.sessionPubKey,
    status: "open",
  };
  if (!usingSupabase()) {
    fallbackWarn("createChallenge");
    const item = { ...row, joiner: null, created_at: nowIso(), updated_at: nowIso() };
    memory.challenges.push(item);
    return item;
  }
  return unwrap(
    await getServerClient().from("duel_challenges").insert(row).select().single(),
    "createChallenge"
  );
}

export async function joinChallenge(duelId, joiner) {
  if (!usingSupabase()) {
    fallbackWarn("joinChallenge");
    const c = memory.challenges.find((x) => x.duel_id === duelId && x.status === "open");
    if (!c) return null;
    c.joiner = joiner;
    c.status = "active";
    c.updated_at = nowIso();
    return c;
  }
  const rows = unwrap(
    await getServerClient()
      .from("duel_challenges")
      .update({ joiner, status: "active", updated_at: nowIso() })
      .eq("duel_id", duelId)
      .eq("status", "open")
      .select(),
    "joinChallenge"
  );
  return rows?.[0] || null;
}

export async function updateChallengeStatus(duelId, status) {
  if (!usingSupabase()) {
    fallbackWarn("updateChallengeStatus");
    const c = memory.challenges.find((x) => x.duel_id === duelId);
    if (!c) return null;
    c.status = status;
    c.updated_at = nowIso();
    return c;
  }
  const rows = unwrap(
    await getServerClient()
      .from("duel_challenges")
      .update({ status, updated_at: nowIso() })
      .eq("duel_id", duelId)
      .select(),
    "updateChallengeStatus"
  );
  return rows?.[0] || null;
}

export async function createEvent(event) {
  const row = {
    duel_id: event.duelId,
    sender: event.sender,
    type: event.type,
    payload: event.payload ?? {},
  };
  if (!usingSupabase()) {
    fallbackWarn("createEvent");
    const item = { id: nextId(), ...row, created_at: nowIso() };
    memory.events.push(item);
    return item;
  }
  return unwrap(
    await getServerClient().from("duel_events").insert(row).select().single(),
    "createEvent"
  );
}

export async function listEvents(duelId, afterId = 0) {
  if (!usingSupabase()) {
    fallbackWarn("listEvents");
    return memory.events
      .filter((e) => e.duel_id === duelId && e.id > afterId)
      .sort((a, b) => a.id - b.id);
  }
  return unwrap(
    await getServerClient()
      .from("duel_events")
      .select("id, duel_id, sender, type, payload, created_at")
      .eq("duel_id", duelId)
      .gt("id", afterId)
      .order("id", { ascending: true }),
    "listEvents"
  );
}

/** Test/dev helper: wipes the in-memory store. No effect on Supabase. */
export function __resetMemoryStore() {
  memory.rooms = [];
  memory.secrets = new Map();
  memory.squads = [];
  memory.slots = [];
  memory.matchLogs = [];
  memory.profiles = [];
  memory.duelLeaderboard = [];
  memory.tournamentRuns = [];
  memory.challenges = [];
  memory.events = [];
  memory.nextId = 1;
}
