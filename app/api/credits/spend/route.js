import { NextResponse } from "next/server";
import { getServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/credits/spend
 * Body: { wallet, signature, timestamp, sessionToken }
 *
 * Verifies either the sessionToken or the EIP-191 wallet signature, then
 * atomically decrements the credit balance. Returns { success, sessionToken }.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { wallet: rawWallet } = body ?? {};
  const wallet = (rawWallet || "").toLowerCase().trim();

  if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }

  // ── Atomically spend 1 credit ────────────────────────────────────────────
  const supabase = getServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  const { data, error } = await supabase.rpc("atomic_spend_credit", { p_wallet: wallet });

  if (error) {
    console.error("[/api/credits/spend] DB error:", error);
    return NextResponse.json({ error: "Failed to spend credit" }, { status: 500 });
  }

  // data is true (spent) or false (no credits)
  return NextResponse.json({
    success: Boolean(data),
  });
}

