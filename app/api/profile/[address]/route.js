import { NextResponse } from "next/server";

import { getProfile } from "@/lib/duel-store";
import { isValidAddress, normaliseAddress } from "@/lib/username";

export const dynamic = "force-dynamic";

/**
 * GET /api/profile/:address
 *
 * Returns { profile: null } with 200 when the address has no username yet, so
 * the client can distinguish "not claimed" from an error and show the claim
 * modal without treating it as a failure.
 */
export async function GET(_request, { params }) {
  const { address } = await params;

  if (!isValidAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  try {
    const profile = await getProfile(normaliseAddress(address));
    return NextResponse.json({ profile: profile ?? null });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to load profile", details: error.message },
      { status: 500 }
    );
  }
}
