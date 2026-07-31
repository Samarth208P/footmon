import { createHmac, timingSafeEqual } from "node:crypto";
import { verifyMessage } from "ethers";

import { normaliseAddress } from "@/lib/username";

/**
 * Duel session tokens.
 *
 * Draft picks must be server-authoritative, which means every pick request has
 * to prove which player sent it. Asking the wallet to sign each pick would mean
 * a MetaMask popup per pick — unusable. So the player signs ONCE per room, and
 * the server issues a short-lived HMAC token bound to (roomId, address) that
 * authorises subsequent pick/ready calls for that room only.
 *
 * The token is a bearer credential: it authorises actions in one room, for one
 * address, until it expires. It carries no privileges beyond that.
 */

const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — longer than any duel
const CLAIM_TTL_MS = 10 * 60 * 1000;
const CLAIM_SKEW_MS = 2 * 60 * 1000;

function secret() {
  const value = process.env.SESSION_SECRET || "";
  if (!value || value.length < 32) {
    throw new Error(
      "[FootMon] SESSION_SECRET is missing or too short (need >= 32 chars). " +
        "Duel sessions cannot be signed. Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return value;
}

export function isSessionSecretConfigured() {
  const value = process.env.SESSION_SECRET || "";
  return value.length >= 32;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function sign(body) {
  return createHmac("sha256", secret()).update(body).digest();
}

/**
 * The message a player signs to open a duel session.
 *
 * ⚠️ Keep in sync with buildSessionMessage() in public/js/duel-session.js.
 */
export function buildSessionMessage({ address, roomCode, issuedAt, nonce }) {
  return [
    "FootMon duel session",
    "",
    `Address: ${normaliseAddress(address)}`,
    `Room: ${roomCode}`,
    `Issued At: ${issuedAt}`,
    `Nonce: ${nonce}`,
    "",
    "Signing authorises this browser to make your draft picks in this room.",
    "It costs no gas and sends no transaction.",
  ].join("\n");
}

export function createSessionToken({ roomId, address, ttlMs = SESSION_TTL_MS }) {
  const payload = {
    r: roomId,
    a: normaliseAddress(address),
    e: Date.now() + ttlMs,
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${b64url(sign(body))}`;
}

/**
 * @returns {{roomId: string, address: string}|null} null when invalid/expired.
 */
export function verifySessionToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;

  const [body, mac] = token.split(".");
  if (!body || !mac) return null;

  let provided;
  let expected;
  try {
    provided = Buffer.from(mac, "base64url");
    expected = sign(body);
  } catch {
    return null;
  }

  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!payload?.r || !payload?.a || typeof payload.e !== "number") return null;
  if (Date.now() > payload.e) return null;

  return { roomId: payload.r, address: payload.a };
}

/** Extracts a bearer token from an incoming request. */
export function tokenFromRequest(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Authorises a request for a specific room.
 * @returns {{ok: true, address: string} | {ok: false, status: number, error: string}}
 */
export function authoriseRoomRequest(request, roomId) {
  const token = tokenFromRequest(request);
  if (!token) {
    return { ok: false, status: 401, error: "Missing duel session token" };
  }
  const session = verifySessionToken(token);
  if (!session) {
    return { ok: false, status: 401, error: "Invalid or expired duel session" };
  }
  if (session.roomId !== roomId) {
    // A token for one room must never act in another.
    return { ok: false, status: 403, error: "Session is for a different room" };
  }
  return { ok: true, address: session.address };
}

/**
 * Verifies the one-time wallet signature that opens a session.
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function verifySessionClaim({ address, roomCode, issuedAt, nonce, signature }) {
  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    return { ok: false, status: 400, error: "Missing signature" };
  }
  if (typeof nonce !== "string" || !/^[0-9a-f]{32}$/i.test(nonce)) {
    return { ok: false, status: 400, error: "Invalid nonce" };
  }

  const ts = Date.parse(issuedAt);
  if (Number.isNaN(ts)) {
    return { ok: false, status: 400, error: "Invalid Issued At timestamp" };
  }
  const now = Date.now();
  if (ts - now > CLAIM_SKEW_MS) {
    return { ok: false, status: 400, error: "Session request is dated in the future" };
  }
  if (now - ts > CLAIM_TTL_MS) {
    return { ok: false, status: 400, error: "Session request expired, please sign again" };
  }

  const message = buildSessionMessage({ address, roomCode, issuedAt, nonce });

  let recovered;
  try {
    recovered = verifyMessage(message, signature);
  } catch {
    return { ok: false, status: 401, error: "Signature could not be verified" };
  }
  if (normaliseAddress(recovered) !== normaliseAddress(address)) {
    return { ok: false, status: 401, error: "Signature does not match the claimed address" };
  }
  return { ok: true };
}
