import { NextResponse } from "next/server";
import { getServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/credits/balance?wallet=0x...
 * Returns the current reroll credit balance for a wallet.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const wallet = (searchParams.get("wallet") || "").toLowerCase().trim();

  if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }

  const supabase = getServerClient();
  if (!supabase) {
    return NextResponse.json({ credits: 0 });
  }

  const { data, error } = await supabase
    .from("reroll_credits")
    .select("credits")
    .eq("wallet", wallet)
    .maybeSingle();

  if (error) {
    console.error("[/api/credits/balance] DB error:", error);
    return NextResponse.json({ error: "Failed to fetch balance" }, { status: 500 });
  }

  return NextResponse.json({ credits: data?.credits ?? 0 });
}
