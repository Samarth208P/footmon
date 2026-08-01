/**
 * Server-authoritative turn timeout handling.
 *
 * Every duel API entry point that reads or writes room state calls
 * advanceExpiredTurn() first. It's a lazy cron — we don't need a scheduler
 * because whichever client polls next will trigger the skip, and both
 * clients poll every 1.5s during a draft.
 *
 * When a turn expires:
 *   * pick_attempts increments (so the draft eventually ends even if
 *     someone AFK-s the whole thing)
 *   * the offending side gets their penalty_max_rating set to 85 —
 *     their NEXT pick is capped at rating ≤ 85 until they use it
 *   * the turn passes to the other side with a fresh deadline
 *   * the current wheel roll is cleared so the incoming drafter starts fresh
 *   * if pick_attempts now hits TOTAL_PICKS, the draft moves to 'simulating'
 *
 * The write is guarded on the (id, current_turn, turn_deadline) triple so
 * two clients racing to advance the same expired turn can't double-count.
 */

import { getRoomByCode, getRoomById, updateRoom } from "@/lib/duel-store";
import {
  addressToPick,
  isDraftComplete,
  isTurnExpired,
  nextTurnDeadline,
  TURN_SECONDS,
} from "@/lib/draft";

/** Rating cap applied on the pick immediately after a timeout. */
export const TIMEOUT_PENALTY_MAX_RATING = 85;

/**
 * Idempotent: if the current turn has expired, advance it. Otherwise
 * returns the room untouched. The room passed in can be stale — we
 * re-check turn_deadline against wall-clock time here, not against a
 * client's clock.
 *
 * Loops so that a very old room (multiple missed turns) catches up in one
 * go rather than requiring one poll per skip.
 *
 * @param {object|null} room  the room record (or null if not found)
 * @returns {Promise<object|null>} the possibly-updated room record
 */
export async function advanceExpiredTurn(room) {
  if (!room) return room;

  let current = room;
  // Cap the loop just in case something weird ever happens with the clock
  // and we somehow have infinitely many expired turns. 30 is far more than
  // TOTAL_PICKS (22) so a legitimate catch-up always fits.
  for (let i = 0; i < 30; i++) {
    if (current.status !== "drafting") return current;
    if (!current.current_turn || !current.turn_deadline) return current;
    if (!isTurnExpired(current.turn_deadline)) return current;

    const attempts = Number(current.pick_attempts ?? 0);
    const nextAttempts = attempts + 1;
    const complete = isDraftComplete(nextAttempts);

    const isCreatorTimeout = current.current_turn === current.creator;

    const patch = {
      pick_attempts: nextAttempts,
      current_roll_nation: null,
      current_roll_year: null,
      current_roll_at: null,
    };
    // Penalise whoever missed. Their next pick is capped at rating <= 85.
    if (isCreatorTimeout) {
      patch.creator_penalty_max_rating = TIMEOUT_PENALTY_MAX_RATING;
    } else {
      patch.joiner_penalty_max_rating = TIMEOUT_PENALTY_MAX_RATING;
    }

    if (complete) {
      patch.status = "simulating";
      patch.current_turn = null;
      patch.turn_deadline = null;
    } else {
      patch.current_turn = addressToPick({
        totalPicks: nextAttempts,
        creator: current.creator,
        joiner: current.joiner,
      });
      patch.turn_deadline = nextTurnDeadline();
    }

    const updated = await updateRoom(current.id, patch);
    if (!updated) return current;
    current = updated;

    // If we transitioned to simulating, stop.
    if (updated.status !== "drafting") return current;
  }
  return current;
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
