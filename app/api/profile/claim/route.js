import { NextResponse } from "next/server";
import { verifyMessage } from "ethers";

import { getProfile, getProfileByUsername, upsertProfile } from "@/lib/duel-store";
import {
  buildClaimMessage,
  checkIssuedAt,
  checkRenameCooldown,
  isValidAddress,
  isValidNonce,
  normaliseAddress,
  validateUsername,
} from "@/lib/username";

export const dynamic = "force-dynamic";

/**
 * POST /api/profile/claim
 *
 * Binds a username to a wallet address, proven by a signature over a message
 * that names both. The signature is the only authorisation: we never trust a
 * client-supplied address on its own, because that would let anyone claim a
 * name on behalf of any wallet.
 *
 * Body: { address, username, issuedAt, nonce, signature }
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const { address, username, issuedAt, nonce, signature } = body ?? {};

  if (!isValidAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }
  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }
  if (!isValidNonce(nonce)) {
    return NextResponse.json({ error: "Invalid nonce" }, { status: 400 });
  }

  const nameCheck = validateUsername(username);
  if (!nameCheck.ok) {
    return NextResponse.json({ error: nameCheck.reason }, { status: 400 });
  }

  const freshness = checkIssuedAt(issuedAt);
  if (!freshness.ok) {
    return NextResponse.json({ error: freshness.reason }, { status: 400 });
  }

  // ── Verify the signature actually comes from `address` ────────────────────
  const message = buildClaimMessage({ address, username, issuedAt, nonce });

  let recovered;
  try {
    recovered = verifyMessage(message, signature);
  } catch {
    return NextResponse.json({ error: "Signature could not be verified" }, { status: 401 });
  }

  const claimed = normaliseAddress(address);
  if (normaliseAddress(recovered) !== claimed) {
    return NextResponse.json(
      { error: "Signature does not match the claimed address" },
      { status: 401 }
    );
  }

  // ── Uniqueness ───────────────────────────────────────────────────────────
  try {
    const holder = await getProfileByUsername(username);
    if (holder && normaliseAddress(holder.address) !== claimed) {
      return NextResponse.json({ error: "That username is already taken" }, { status: 409 });
    }

    const existing = await getProfile(claimed);

    // Re-claiming the identical name is a no-op and must not burn the cooldown.
    if (existing && existing.username === username) {
      return NextResponse.json({ profile: existing, unchanged: true });
    }

    // ── Rename cooldown ────────────────────────────────────────────────────
    if (existing) {
      const cooldown = checkRenameCooldown(existing.username_updated_at);
      if (!cooldown.allowed) {
        const days = Math.ceil(cooldown.retryAfterMs / (24 * 60 * 60 * 1000));
        return NextResponse.json(
          {
            error: `You can change your username again in ${days} day${days === 1 ? "" : "s"}`,
            retryAfterMs: cooldown.retryAfterMs,
          },
          { status: 429 }
        );
      }
    }

    const profile = await upsertProfile({ address: claimed, username });
    return NextResponse.json({ profile }, { status: existing ? 200 : 201 });
  } catch (error) {
    // A unique-violation can still race between the check and the write.
    if (error?.code === "23505" || /duplicate key/i.test(error?.message ?? "")) {
      return NextResponse.json({ error: "That username is already taken" }, { status: 409 });
    }
    return NextResponse.json(
      { error: "Failed to claim username", details: error.message },
      { status: 500 }
    );
  }
}
