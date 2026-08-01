/**
 * Server-authoritative draft rules.
 *
 * Turn order and pick legality must not be decided by the client: whoever wins
 * receives escrowed MON, so a client that could pick out of turn, reuse a
 * footballer, or drop a goalkeeper into a striker slot could rig the result.
 *
 * Pure module — no database, no network — so every rule below is unit testable.
 */

/** Mirrors POSITION_COMPAT in public/js/config.js. */
export const POSITION_COMPAT = {
  GK: ["GK"],
  CB: ["CB"],
  LB: ["LB", "LWB"],
  RB: ["RB", "RWB"],
  CM: ["CM", "DM", "AM", "CDM", "CAM"],
  LM: ["LM"],
  RM: ["RM"],
  ST: ["ST", "CF", "SS"],
  LW: ["LW"],
  RW: ["RW"],
  CF: ["CF", "ST", "SS"],
};

/** Duels are fixed 4-3-3; mirrors FORMATIONS["4-3-3"].slots order in config.js. */
export const DUEL_FORMATION = "4-3-3";
export const DUEL_SLOTS = ["GK", "LB", "CB", "CB", "RB", "CM", "CM", "CM", "LW", "ST", "RW"];
export const SQUAD_SIZE = DUEL_SLOTS.length; // 11
export const TOTAL_PICKS = SQUAD_SIZE * 2; // both players

/** Seconds a player has to make a pick before their turn is skipped
 *  (or, in the classic branch, before an opponent can claim forfeit). */
export const TURN_SECONDS = 90;
/** Seconds both players have to ready up before the duel can be refunded. */
export const READY_SECONDS = 120;
/** Grace period after a disconnect before auto-forfeit is allowed. */
export const DISCONNECT_GRACE_SECONDS = 30;

export function slotPositionFor(slotIndex) {
  return DUEL_SLOTS[slotIndex] ?? null;
}

export function isValidSlotIndex(slotIndex) {
  return Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex < SQUAD_SIZE;
}

/**
 * Can `playerPositions` fill the slot at `slotIndex`?
 * Accepts a single position string or a list, matching the shapes in the data.
 */
export function canFillSlot(slotIndex, playerPositions) {
  const slotPos = slotPositionFor(slotIndex);
  if (!slotPos) return false;

  const allowed = POSITION_COMPAT[slotPos];
  if (!allowed) return false;

  const list = Array.isArray(playerPositions)
    ? playerPositions
    : String(playerPositions ?? "")
        .split(/[,\s/]+/)
        .filter(Boolean);

  return list.some((p) => allowed.includes(String(p).toUpperCase()));
}

/**
 * Whose turn is it, derived from how many picks exist.
 *
 * Deriving rather than storing means the turn can never drift out of sync with
 * the picks actually persisted — a stored pointer could be updated twice by a
 * retry and silently skip a player's turn.
 *
 * Creator picks on even counts, joiner on odd: C, J, C, J, ...
 */
export function sideToPick(totalPicks) {
  if (!Number.isInteger(totalPicks) || totalPicks < 0) return null;
  if (totalPicks >= TOTAL_PICKS) return null; // draft finished
  return totalPicks % 2 === 0 ? "creator" : "joiner";
}

export function addressToPick({ totalPicks, creator, joiner }) {
  const side = sideToPick(totalPicks);
  if (!side) return null;
  return side === "creator" ? creator : joiner;
}

export function isDraftComplete(totalPicks) {
  return totalPicks >= TOTAL_PICKS;
}

/**
 * Validates a pick attempt.
 *
 * @param {object} p
 * @param {string} p.sender             address making the request
 * @param {string} p.creator
 * @param {string} p.joiner
 * @param {number} p.totalPicks         picks already persisted across both squads
 * @param {number} p.slotIndex
 * @param {string|string[]} p.playerPositions
 * @param {string} p.playerName
 * @param {number[]} p.usedSlotIndexes  slots this player has already filled
 * @param {string[]} p.usedPlayerNames  footballers this player has already used
 * @returns {{ok: true, side: string} | {ok: false, status: number, error: string}}
 */
export function validatePick({
  sender,
  creator,
  joiner,
  totalPicks,
  slotIndex,
  playerPositions,
  playerName,
  usedSlotIndexes = [],
  usedPlayerNames = [],
}) {
  if (!joiner) {
    return { ok: false, status: 409, error: "The duel has no opponent yet" };
  }
  if (isDraftComplete(totalPicks)) {
    return { ok: false, status: 409, error: "The draft is already complete" };
  }

  const expected = addressToPick({ totalPicks, creator, joiner });
  const from = String(sender ?? "").toLowerCase();

  if (from !== String(creator).toLowerCase() && from !== String(joiner).toLowerCase()) {
    return { ok: false, status: 403, error: "You are not a participant in this duel" };
  }
  if (from !== String(expected).toLowerCase()) {
    return { ok: false, status: 409, error: "It is not your turn" };
  }

  if (!isValidSlotIndex(slotIndex)) {
    return { ok: false, status: 400, error: "Invalid slot" };
  }
  if (usedSlotIndexes.includes(slotIndex)) {
    return { ok: false, status: 409, error: "That slot is already filled" };
  }

  if (typeof playerName !== "string" || playerName.trim().length === 0) {
    return { ok: false, status: 400, error: "Missing player name" };
  }

  // Prevent the same real-world footballer from appearing twice in one squad,
  // even if drafted from a different World Cup year (names are stored without
  // year suffixes, so "Lionel Messi" from 2014 and 2022 share the same name).
  const normName = playerName.trim().toLowerCase();
  const alreadyUsed = usedPlayerNames.some(
    (n) => String(n).trim().toLowerCase() === normName
  );
  if (alreadyUsed) {
    return { ok: false, status: 409, error: "That player is already in your squad (same player from another year is not allowed)" };
  }

  if (!canFillSlot(slotIndex, playerPositions)) {
    return {
      ok: false,
      status: 400,
      error: `A ${Array.isArray(playerPositions) ? playerPositions.join("/") : playerPositions} cannot play ${slotPositionFor(slotIndex)}`,
    };
  }

  return { ok: true, side: from === String(creator).toLowerCase() ? "creator" : "joiner" };
}

/** True once the deadline has passed, so the turn can be forfeited. */
export function isTurnExpired(turnDeadline, now = Date.now()) {
  if (!turnDeadline) return false;
  const deadline = Date.parse(turnDeadline);
  if (Number.isNaN(deadline)) return false;
  return now > deadline;
}

export function nextTurnDeadline(now = Date.now()) {
  return new Date(now + TURN_SECONDS * 1000).toISOString();
}

export function readyDeadline(now = Date.now()) {
  return new Date(now + READY_SECONDS * 1000).toISOString();
}
