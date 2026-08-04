import { NextResponse } from "next/server";
import { verifyMessage } from "ethers";
import { getServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const SIGNATURE_MAX_AGE_MS = 60_000; // 60 seconds

/**
 * POST /api/credits/spend
 * Body: { wallet, signature, timestamp }
 *
 * Verifies the EIP-191 wallet signature (zero gas, instant), then
 * atomically decrements the credit balance. Returns { success: true/false }.
 *
 * Security:
 *  - signature prevents a different user from spending another's credits
 *  - timestamp prevents replay attacks (valid only for 60 s)
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { wallet: rawWallet, signature, timestamp } = body ?? {};
  const wallet = (rawWallet || "").toLowerCase().trim();

  if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }
  if (!signature || typeof signature !== "string") {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }
  if (!timestamp || typeof timestamp !== "number") {
    return NextResponse.json({ error: "Missing timestamp" }, { status: 400 });
  }

  // ── Replay protection ───────────────────────────────────────────────────
  const age = Date.now() - timestamp;
  if (age < 0 || age > SIGNATURE_MAX_AGE_MS) {
    return NextResponse.json({ error: "Signature expired (max 60s)" }, { status: 401 });
  }

  // ── Signature verification ───────────────────────────────────────────────
  const message = `footmon-reroll:${timestamp}`;
  try {
    const recovered = verifyMessage(message, signature);
    if (recovered.toLowerCase() !== wallet) {
      return NextResponse.json({ error: "Signature does not match wallet" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
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
  return NextResponse.json({ success: Boolean(data) });
}
