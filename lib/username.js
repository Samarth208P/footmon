/**
 * Username rules and the canonical claim message.
 *
 * The message template below MUST stay byte-identical to the one built in
 * public/js/profile.js — a single character of drift makes every signature fail
 * verification. Both copies carry this warning.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;

/** Mirrors the profiles_username_chars / _len constraints in the migration. */
export const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;

/** A claim signature is only accepted this long after it was issued. */
export const CLAIM_TTL_MS = 10 * 60 * 1000;

/** Tolerance for a client clock running ahead of the server. */
export const CLAIM_SKEW_MS = 2 * 60 * 1000;

/** A username may be changed once per this window. */
export const RENAME_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** Names that would impersonate the app or muddle the UI. */
const RESERVED = new Set([
  "admin",
  "footmon",
  "moderator",
  "mod",
  "owner",
  "resolver",
  "system",
  "support",
  "you",
  "unclaimed",
  "null",
  "undefined",
  "anonymous",
]);

export function isValidAddress(address) {
  return typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address);
}

export function normaliseAddress(address) {
  return String(address).toLowerCase();
}

/**
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateUsername(username) {
  if (typeof username !== "string") {
    return { ok: false, reason: "Username must be a string" };
  }
  const trimmed = username.trim();
  if (trimmed !== username) {
    return { ok: false, reason: "Username must not have leading or trailing spaces" };
  }
  if (trimmed.length < USERNAME_MIN || trimmed.length > USERNAME_MAX) {
    return {
      ok: false,
      reason: `Username must be ${USERNAME_MIN}-${USERNAME_MAX} characters`,
    };
  }
  if (!USERNAME_PATTERN.test(trimmed)) {
    return { ok: false, reason: "Username may only contain letters, numbers and underscores" };
  }
  if (RESERVED.has(trimmed.toLowerCase())) {
    return { ok: false, reason: "That username is reserved" };
  }
  return { ok: true };
}

export function isValidNonce(nonce) {
  return typeof nonce === "string" && /^[0-9a-f]{32}$/i.test(nonce);
}

/**
 * The exact string the wallet signs.
 *
 * ⚠️ Keep in sync with buildClaimMessage() in public/js/profile.js.
 */
export function buildClaimMessage({ address, username, issuedAt, nonce }) {
  return [
    "FootMon username claim",
    "",
    `Address: ${normaliseAddress(address)}`,
    `Username: ${username}`,
    `Issued At: ${issuedAt}`,
    `Nonce: ${nonce}`,
    "",
    "Signing proves you control this wallet.",
    "It costs no gas and sends no transaction.",
  ].join("\n");
}

/**
 * Validates claim freshness. Rejecting stale signatures bounds the replay
 * window; replay within it is harmless anyway because the message binds both
 * the address and the exact username being claimed.
 */
export function checkIssuedAt(issuedAt, now = Date.now()) {
  const ts = Date.parse(issuedAt);
  if (Number.isNaN(ts)) return { ok: false, reason: "Invalid Issued At timestamp" };
  if (ts - now > CLAIM_SKEW_MS) return { ok: false, reason: "Claim is dated in the future" };
  if (now - ts > CLAIM_TTL_MS) return { ok: false, reason: "Claim has expired, please sign again" };
  return { ok: true };
}

/**
 * @returns {{allowed: true} | {allowed: false, retryAfterMs: number}}
 */
export function checkRenameCooldown(usernameUpdatedAt, now = Date.now()) {
  if (!usernameUpdatedAt) return { allowed: true };
  const last = Date.parse(usernameUpdatedAt);
  if (Number.isNaN(last)) return { allowed: true };
  const elapsed = now - last;
  if (elapsed >= RENAME_COOLDOWN_MS) return { allowed: true };
  return { allowed: false, retryAfterMs: RENAME_COOLDOWN_MS - elapsed };
}
