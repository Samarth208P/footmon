import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

/**
 * Room password hashing.
 *
 * scrypt with a per-hash random salt. The cost parameters are stored inside the
 * encoded string so they can be raised later without invalidating existing
 * hashes.
 */

const N = 16384; // CPU/memory cost
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;

export const PASSWORD_MIN = 4;
export const PASSWORD_MAX = 128;

export function validatePassword(password) {
  if (typeof password !== "string") {
    return { ok: false, reason: "Password must be a string" };
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return {
      ok: false,
      reason: `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`,
    };
  }
  return { ok: true };
}

/** @returns {Promise<string>} `scrypt$N$r$p$saltB64$hashB64` */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64"),
    Buffer.from(derived).toString("base64"),
  ].join("$");
}

/**
 * Constant-time verification. Returns false rather than throwing on a malformed
 * stored hash, so a corrupt row denies access instead of crashing the route.
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived;
  try {
    derived = Buffer.from(await scrypt(password, salt, expected.length, { N: n, r, p }));
  } catch {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
