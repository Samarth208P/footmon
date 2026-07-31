import { randomInt } from "node:crypto";

/**
 * Shareable room codes.
 *
 * Excludes characters that are easy to misread when a code is typed from a
 * screenshot or read aloud: 0/O and 1/I. The DB constraint is ^[A-Z0-9]{6,10}$,
 * which this satisfies.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LENGTH = 8;

export function generateRoomCode() {
  let code = "";
  for (let i = 0; i < LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

export function isValidRoomCode(code) {
  return typeof code === "string" && /^[A-Z0-9]{6,10}$/.test(code);
}

/** Codes are case-insensitive and often pasted with stray whitespace. */
export function normaliseRoomCode(code) {
  return String(code ?? "").trim().toUpperCase();
}

/**
 * Retries until the code is unused. Collisions are astronomically unlikely
 * (32^8) but a duplicate would violate the unique index, so a bounded retry
 * keeps room creation from failing on a coin flip.
 */
export async function generateUniqueRoomCode(exists, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const code = generateRoomCode();
    if (!(await exists(code))) return code;
  }
  throw new Error("Could not allocate a unique room code");
}
