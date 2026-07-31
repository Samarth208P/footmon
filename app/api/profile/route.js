import { NextResponse } from "next/server";

import { getProfiles } from "@/lib/duel-store";
import { isValidAddress, normaliseAddress } from "@/lib/username";

export const dynamic = "force-dynamic";

const MAX_BATCH = 100;

/**
 * GET /api/profile?addresses=0xabc...,0xdef...
 *
 * Returns { usernames: { "0xabc...": "Pele" } } for the addresses that have a
 * profile. Unclaimed addresses are simply absent from the map.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("addresses") || "";

  const requested = raw
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  if (requested.length === 0) {
    return NextResponse.json({ usernames: {} });
  }
  if (requested.length > MAX_BATCH) {
    return NextResponse.json(
      { error: `Too many addresses (max ${MAX_BATCH})` },
      { status: 400 }
    );
  }
  const invalid = requested.filter((a) => !isValidAddress(a));
  if (invalid.length > 0) {
    return NextResponse.json({ error: "Invalid address in list" }, { status: 400 });
  }

  try {
    const rows = await getProfiles(requested.map(normaliseAddress));
    const usernames = {};
    for (const row of rows) usernames[row.address] = row.username;
    return NextResponse.json({ usernames });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to load profiles", details: error.message },
      { status: 500 }
    );
  }
}
