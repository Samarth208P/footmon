import { NextResponse } from "next/server";
import { JsonRpcProvider, Contract, parseEther } from "ethers";
import { getServerClient } from "@/lib/supabase-server";
import { CONTRACT_ADDRESS, FOOTMON_ABI, MONAD_CHAIN, CREDIT_PRIZE_CONTRIBUTION_MON } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * Bundle definitions — must stay in sync with MarketplaceClient.jsx.
 * price_mon: what the user pays per roll (base is 0.01, discounted for big bundles).
 */
const BUNDLES = {
  starter:  { rerolls: 20,   price_mon: "0.200"  },
  value:    { rerolls: 30,   price_mon: "0.270"  },
  pro:      { rerolls: 50,   price_mon: "0.425"  },
  elite:    { rerolls: 100,  price_mon: "0.800"  },
  champion: { rerolls: 500,  price_mon: "3.750"  },
  legend:   { rerolls: 1000, price_mon: "7.000"  },
};

/**
 * POST /api/credits/purchase
 * Body: { wallet, txHash, bundleId }
 *
 * Verifies the on-chain tx paid the correct amount for the bundle,
 * then credits the wallet. Idempotent on txHash.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { wallet: rawWallet, txHash, bundleId } = body ?? {};
  const wallet = (rawWallet || "").toLowerCase().trim();

  if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }
  if (!txHash || !/^0x[0-9a-f]{64}$/.test(txHash.toLowerCase())) {
    return NextResponse.json({ error: "Invalid txHash" }, { status: 400 });
  }
  const bundle = BUNDLES[bundleId];
  if (!bundle) {
    return NextResponse.json({ error: `Unknown bundleId '${bundleId}'` }, { status: 400 });
  }

  const supabase = getServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  // ── Idempotency check ───────────────────────────────────────────────────
  const { data: existing } = await supabase
    .from("credit_purchases")
    .select("id, credits_added")
    .eq("tx_hash", txHash.toLowerCase())
    .maybeSingle();

  if (existing) {
    return NextResponse.json({
      success: true,
      credits_added: existing.credits_added,
      already_processed: true,
    });
  }

  // ── Verify the on-chain tx ──────────────────────────────────────────────
  try {
    const provider = new JsonRpcProvider(MONAD_CHAIN.rpcUrls[0]);
    const receipt = await provider.getTransactionReceipt(txHash);

    if (!receipt) {
      return NextResponse.json({ error: "Transaction not found or not yet mined" }, { status: 404 });
    }
    if (receipt.status !== 1) {
      return NextResponse.json({ error: "Transaction reverted on-chain" }, { status: 400 });
    }

    // Verify it was sent to our contract
    const tx = await provider.getTransaction(txHash);
    if (!tx) {
      return NextResponse.json({ error: "Transaction details unavailable" }, { status: 404 });
    }
    if (tx.to?.toLowerCase() !== CONTRACT_ADDRESS?.toLowerCase()) {
      return NextResponse.json({ error: "Transaction was not sent to the FootMon contract" }, { status: 400 });
    }

    // Verify the sender is the wallet claiming the credits
    if (tx.from?.toLowerCase() !== wallet) {
      return NextResponse.json({ error: "Transaction sender does not match wallet" }, { status: 403 });
    }

    // Verify the value is at least the bundle price
    const expectedWei = parseEther(bundle.price_mon);
    if (tx.value < expectedWei) {
      return NextResponse.json({
        error: `Insufficient payment. Expected ${bundle.price_mon} MON, got ${tx.value.toString()} wei`,
      }, { status: 400 });
    }
  } catch (err) {
    if (err.status === 400 || err.status === 403 || err.status === 404) throw err;
    console.error("[/api/credits/purchase] On-chain verification failed:", err);
    return NextResponse.json({ error: "Failed to verify transaction on-chain" }, { status: 500 });
  }

  // ── Record purchase + credit the wallet ─────────────────────────────────
  const creditsAdded = bundle.rerolls;
  const prizePotOwed = (creditsAdded * parseFloat(CREDIT_PRIZE_CONTRIBUTION_MON)).toFixed(8);

  // Upsert the reroll_credits row (insert or increment)
  const { error: upsertErr } = await supabase.rpc("increment_credits", {
    p_wallet: wallet,
    p_amount: creditsAdded,
  });

  if (upsertErr) {
    // Fallback: manual upsert if the RPC doesn't exist yet
    const { error: insertErr } = await supabase
      .from("reroll_credits")
      .upsert({ wallet, credits: creditsAdded }, { onConflict: "wallet", ignoreDuplicates: false });

    // If row exists, increment instead
    if (insertErr) {
      await supabase.rpc("atomic_spend_credit", { p_wallet: wallet }); // just to ensure row exists
      await supabase
        .from("reroll_credits")
        .update({ credits: supabase.raw(`credits + ${creditsAdded}`) })
        .eq("wallet", wallet);
    }
  }

  // Record the purchase
  await supabase.from("credit_purchases").insert({
    wallet,
    bundle_id: bundleId,
    credits_added: creditsAdded,
    amount_mon: parseFloat(bundle.price_mon),
    prize_pot_owed: parseFloat(prizePotOwed),
    tx_hash: txHash.toLowerCase(),
  });

  // Fetch updated balance
  const { data: updated } = await supabase
    .from("reroll_credits")
    .select("credits")
    .eq("wallet", wallet)
    .maybeSingle();

  return NextResponse.json({
    success: true,
    credits_added: creditsAdded,
    total_credits: updated?.credits ?? creditsAdded,
  });
}
