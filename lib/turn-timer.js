/**
 * Server-authoritative turn timeout handling.
 *
 * Every duel API entry point that reads or writes room state calls
 * advanceExpiredTurn() first. It's a lazy cron — we don't need a scheduler
 * because whichever client polls next will trigger the penalty check.
 *
 * When a turn expires:
 *   * the offending side gets their penalty_max_rating set to 85 —
 *     their next pick is capped at rating ≤ 85
 *   * the turn STAYS on the same player — they keep their current roll,
 *     the same nation, the same list of players; nothing is reshuffled
 *   * a fresh deadline is set for the same player so the countdown UI
 *     doesn't sit at "0:00" forever
 *
 * There is no forfeit path any more — the opponent cannot claim a win
 * from a timeout. The only ways a duel ends prematurely are voluntary
 * quit (self-forfeit) or the draft completing normally.
 *
 * pick_attempts is only incremented on a real successful pick (see
 * pick/route.js). Refreshing the deadline is idempotent as long as
 * advanceExpiredTurn is only called sequentially per room; multiple
 * concurrent callers would each try to write once, but Postgres handles
 * the last-writer-wins case safely (no double-charge because we don't
 * mutate pick_attempts here any more).
 */

import { getRoomByCode, getRoomById, updateRoom } from "@/lib/duel-store";
import {
  isTurnExpired,
  nextTurnDeadline,
  TURN_SECONDS,
} from "@/lib/draft";

/** Rating cap applied on the pick immediately after a timeout. */
export const TIMEOUT_PENALTY_MAX_RATING = 85;

/**
 * Idempotent: if the current turn has expired, apply the penalty cap to
 * whoever is on the clock and refresh their deadline. Turn ownership,
 * pick_attempts, and the current roll (nation/year/list) are all
 * preserved so the drafter can pick up exactly where they left off.
 *
 * @param {object|null} room  the room record (or null if not found)
 * @returns {Promise<object|null>} the possibly-updated room record
 */
export async function advanceExpiredTurn(room) {
  if (!room) return room;

  if (room.status !== "drafting") return room;
  if (!room.current_turn || !room.turn_deadline) return room;
  if (!isTurnExpired(room.turn_deadline)) return room;

  const isCreatorTimeout = room.current_turn === room.creator;

  const patch = {
    // Give the same player a fresh 90s window so the on-screen timer
    // resets and they know they're still in control of the pick.
    turn_deadline: nextTurnDeadline(),
  };

  // Only apply the penalty once — if it's already set for this side we
  // leave it alone rather than re-writing the same value on every poll.
  if (isCreatorTimeout) {
    if (room.creator_penalty_max_rating == null) {
      patch.creator_penalty_max_rating = TIMEOUT_PENALTY_MAX_RATING;
    }
  } else {
    if (room.joiner_penalty_max_rating == null) {
      patch.joiner_penalty_max_rating = TIMEOUT_PENALTY_MAX_RATING;
    }
  }

  const updated = await updateRoom(room.id, patch);
  return updated || room;
}

/**
 * Convenience: fetch by code AND advance if the turn's expired. Useful for
 * routes that need a fresh room state before doing their own work.
 */
export async function loadRoomWithFreshTurn(roomCode) {
  const room = await getRoomByCode(roomCode);
  return advanceExpiredTurn(room);
}

/** Convenience: same but by uuid. */
export async function loadRoomWithFreshTurnById(id) {
  const room = await getRoomById(id);
  return advanceExpiredTurn(room);
}

// Re-exported so callers can use one import point.
export { TURN_SECONDS };
