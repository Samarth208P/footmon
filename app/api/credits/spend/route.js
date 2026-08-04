import { NextResponse } from "next/server";
import { verifyMessage } from "ethers";
import { getServerClient } from "@/lib/supabase-server";
import { verifyWalletSessionToken, createWalletSessionToken } from "@/lib/session";

export const dynamic = "force-dynamic";

const SIGNATURE_MAX_AGE_MS = 60_000; // 60 seconds

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

  const { wallet: rawWallet, signature, timestamp, sessionToken } = body ?? {};
  const wallet = (rawWallet || "").toLowerCase().trim();

  if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }

  let session = null;
  let newSessionToken = null;

  if (sessionToken) {
    session = verifyWalletSessionToken(sessionToken);
    if (!session || session.address !== wallet) {
      return NextResponse.json({ error: "Invalid or expired session token" }, { status: 401 });
    }
  } else {
    // ── Fall back to signature verification ──────────────────────────────────
    if (!signature || typeof signature !== "string") {
      return NextResponse.json({ error: "Missing signature or sessionToken" }, { status: 400 });
    }
    if (!timestamp || typeof timestamp !== "number") {
      return NextResponse.json({ error: "Missing timestamp" }, { status: 400 });
    }

    // ── Replay protection ───────────────────────────────────────────────────
    const age = Date.now() - timestamp;
    if (age < 0 || age > SIGNATURE_MAX_AGE_MS) {
      return NextResponse.json({ error: "Signature expired (max 60s)" }, { status: 401 });
    }

    // ── Signature verification ──────────────────────────────────────────────
    const message = `footmon-reroll:${timestamp}`;
    try {
      const recovered = verifyMessage(message, signature);
      if (recovered.toLowerCase() !== wallet) {
        return NextResponse.json({ error: "Signature does not match wallet" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    // Generate a new session token that the client can use for subsequent rerolls
    newSessionToken = createWalletSessionToken({ address: wallet });
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
    sessionToken: newSessionToken || sessionToken || null,
  });
}

