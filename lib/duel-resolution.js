import {
  appendMatchLog,
  getSquad,
  listMatchLogs,
  listSquadSlots,
  recordDuelResult,
  updateRoom,
} from "@/lib/duel-store";
import { simulateMatch, teamRating } from "@/lib/match-engine";
import {
  DUEL_STATUS,
  getResolverContract,
  isResolverConfigured,
  readDuel,
} from "@/lib/chain";

/**
 * Duel resolution: run the match, persist it, then settle escrow.
 *
 * Ordering is deliberate. The match log is written BEFORE the chain call so that
 * if the resolver transaction fails, the result is still recorded and auditable
 * and the duel can be retried or refunded — rather than money moving with no
 * record, or a result existing with no way to reconcile it.
 */

/**
 * Loads a player's picked XI in slot order, shaped for the engine.
 *
 * Nation and year are carried through per-slot so the hidden chemistry
 * system can reward same-nation and same-era cores. Older squads drafted
 * before the schema had these columns will simply see 0 chemistry from
 * those axes, which is graceful degradation, not a bug.
 */
export async function loadSquadPlayers(roomId, player) {
  const squad = await getSquad(roomId, player);
  if (!squad) return { squad: null, players: [] };

  const slots = await listSquadSlots(squad.id);
  const players = slots.map((slot) => ({
    name: slot.player_name,
    position: slot.player_position || slot.slot_pos,
    slotPos: slot.slot_pos,
    rating: Number(slot.player_rating ?? 0),
    // Optional: only present once the slots table carries these columns.
    // The chemistry calculator reads either `nation`/`year` or the
    // `drafted*` aliases, so we set both for maximum compatibility.
    nation: slot.player_nation ?? null,
    year: slot.player_year ?? null,
    draftedNation: slot.player_nation ?? null,
    draftedYear: slot.player_year ?? null,
  }));
  return { squad, players };
}

/**
 * Simulates a duel and persists every tick.
 *
 * Idempotent: if match_logs already exist for the room, the stored match is
 * returned instead of being re-run. A retried request must never produce a
 * second, different scoreline for the same duel.
 */
export async function runDuelSimulation(room) {
  const existing = await listMatchLogs(room.id);
  if (existing.length > 0) {
    return { alreadySimulated: true, logs: existing };
  }

  const [creatorSide, joinerSide] = await Promise.all([
    loadSquadPlayers(room.id, room.creator),
    loadSquadPlayers(room.id, room.joiner),
  ]);

  // With the timeout auto-advance in place, a squad can legitimately arrive
  // here with fewer than 11 players — even zero, if the drafter AFK'd the
  // whole draft. simulateMatch handles 1+ players naturally (skipped slots
  // just don't contribute), but it requires each side to field at least
  // one player. Handle the 0-player edge by short-circuiting to a "forfeit"
  // style result so the match reveal still has something to render.
  const creatorEmpty = creatorSide.players.length === 0;
  const joinerEmpty = joinerSide.players.length === 0;
  if (creatorEmpty || joinerEmpty) {
    const logs = await recordWalkoverLogs(room, { creatorEmpty, joinerEmpty });
    return { alreadySimulated: false, logs, walkover: true };
  }

  const seed = room.match_seed;
  if (!seed) {
    // Without a stored seed the result would not be reproducible, so refuse
    // rather than invent one now.
    throw new Error("Cannot simulate: room has no recorded match_seed");
  }

  const result = simulateMatch({
    seed,
    home: { key: "creator", players: creatorSide.players },
    away: { key: "joiner", players: joinerSide.players },
    // Wagered head-to-head is a knockout: a level match after 90' resolves
    // via a penalty shootout so there is always a decisive winner. The
    // contract's resolveDuelDraw path stays as a safety net for forfeits
    // and engine failures, but the happy path never hits it any more.
    knockout: true,
    // Duel mode: chemistry rewards a cohesive squad, and the xG curve is
    // balanced so a well-drafted underdog isn't a total lock to lose.
    mode: "duel",
  });

  // Persist ticks in order. `seq` is unique per room, so a retry cannot duplicate.
  const logs = [];
  for (const event of result.events) {
    logs.push(
      await appendMatchLog({
        roomId: room.id,
        mode: "duel",
        seq: event.seq,
        minute: event.minute,
        eventType: event.eventType,
        team: event.team,
        scorerName: event.scorerName,
        scoreCreator: event.scoreCreator,
        scoreJoiner: event.scoreJoiner,
        payload: event.payload ?? {},
      })
    );
  }

  const winnerAddress =
    result.winner === "home"
      ? room.creator
      : result.winner === "away"
        ? room.joiner
        : null;

  await updateRoom(room.id, {
    score_creator: result.homeScore,
    score_joiner: result.awayScore,
    winner: winnerAddress,
    is_draw: result.winner === null,
  });

  return { result, logs, winnerAddress, alreadySimulated: false };
}

/**
 * Settles escrow for a decided duel.
 *
 * @returns {Promise<{ok: true, txHash: string|null, skipped?: string} | {ok: false, error: string}>}
 */
export async function settleDuelOnChain({ room, winnerAddress, isDraw }) {
  if (!isResolverConfigured()) {
    return { ok: false, error: "RESOLVER_PRIVATE_KEY is not configured" };
  }

  // Never send a transaction without checking on-chain state first: the duel may
  // already be resolved or refunded, and resolveDuel would revert.
  let onChain;
  try {
    onChain = await readDuel(room.duel_id);
  } catch (err) {
    return { ok: false, error: `Could not read duel from chain: ${err.message}` };
  }

  if (onChain.status === DUEL_STATUS.RESOLVED) {
    return { ok: true, txHash: null, skipped: "already resolved on-chain" };
  }
  if (onChain.status !== DUEL_STATUS.FULL) {
    return {
      ok: false,
      error: `Duel is not settleable on-chain (status ${onChain.status})`,
    };
  }

  const contract = getResolverContract();

  try {
    const tx = isDraw
      ? await contract.resolveDuelDraw(room.duel_id)
      : await contract.resolveDuel(room.duel_id, winnerAddress);

    const receipt = await tx.wait();
    return { ok: true, txHash: receipt?.hash ?? tx.hash };
  } catch (err) {
    return { ok: false, error: err.shortMessage || err.message };
  }
}

/** Updates the duel leaderboard for both players once a result is final. */
export async function recordDuelOutcome({ room, winnerAddress, isDraw, payoutWei = "0" }) {
  const creatorGoals = Number(room.score_creator ?? 0);
  const joinerGoals = Number(room.score_joiner ?? 0);

  const creatorWon = !isDraw && winnerAddress === room.creator;
  const joinerWon = !isDraw && winnerAddress === room.joiner;

  await recordDuelResult({
    address: room.creator,
    won: creatorWon,
    drew: isDraw,
    goalsFor: creatorGoals,
    goalsAgainst: joinerGoals,
    monWon: creatorWon ? payoutWei : "0",
  });

  await recordDuelResult({
    address: room.joiner,
    won: joinerWon,
    drew: isDraw,
    goalsFor: joinerGoals,
    goalsAgainst: creatorGoals,
    monWon: joinerWon ? payoutWei : "0",
  });
}

/** Winner's share of the pot, from the contract's configured rake. */
export function winnerPayoutWei(stakeWei, housePct) {
  const pot = BigInt(stakeWei) * 2n;
  const house = (pot * BigInt(housePct)) / 100n;
  return (pot - house).toString();
}

/**
 * Writes the match-log entries for a walkover — one side (or both) came
 * out of the draft with zero players. Score is 3-0 in favour of the side
 * that showed up; if BOTH sides no-showed, it's a 0-0 draw. Also updates
 * the room's score/winner fields so the reveal card can read them.
 *
 * We still write the same kickoff/full_time markers as a normal sim so
 * the DuelMatchScreen's timeline UI doesn't have to special-case
 * walkovers.
 */
async function recordWalkoverLogs(room, { creatorEmpty, joinerEmpty }) {
  const isDraw = creatorEmpty && joinerEmpty;
  let scoreCreator = 0;
  let scoreJoiner = 0;
  let winner = null;

  if (!isDraw) {
    if (creatorEmpty) {
      scoreJoiner = 3;
      winner = room.joiner;
    } else {
      scoreCreator = 3;
      winner = room.creator;
    }
  }

  const logs = [];
  logs.push(
    await appendMatchLog({
      roomId: room.id,
      mode: "duel",
      seq: 0,
      minute: 0,
      eventType: "kickoff",
      scoreCreator: 0,
      scoreJoiner: 0,
    })
  );
  logs.push(
    await appendMatchLog({
      roomId: room.id,
      mode: "duel",
      seq: 1,
      minute: 0,
      eventType: "forfeit",
      team: creatorEmpty ? "creator" : "joiner",
      scoreCreator,
      scoreJoiner,
      payload: {
        reason: isDraw ? "both_empty" : "empty_squad",
      },
    })
  );
  logs.push(
    await appendMatchLog({
      roomId: room.id,
      mode: "duel",
      seq: 2,
      minute: 90,
      eventType: "full_time",
      scoreCreator,
      scoreJoiner,
    })
  );

  await updateRoom(room.id, {
    score_creator: scoreCreator,
    score_joiner: scoreJoiner,
    winner,
    is_draw: isDraw,
  });

  return logs;
}
