import { NextResponse } from "next/server";
import { Contract, JsonRpcProvider, Wallet, parseEther } from "ethers";
import { getDailyRerollsCountForDay } from "@/lib/duel-store";
import { CONTRACT_ADDRESS, FOOTMON_ABI } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const rpcUrl = process.env.MONAD_RPC_URL;
    const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
    const contractAddress = CONTRACT_ADDRESS;

    if (!rpcUrl || !deployerKey || !contractAddress) {
      return NextResponse.json(
        { error: "Missing configuration on server" },
        { status: 500 }
      );
    }

    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(deployerKey, provider);
    const contract = new Contract(contractAddress, FOOTMON_ABI, wallet);

    // 1. Check if the daily interval has actually elapsed on-chain
    const [lastPayoutTime, payoutInterval, entriesCount] = await Promise.all([
      contract.lastPayoutTime(),
      contract.payoutInterval(),
      contract.getEntriesCount(),
    ]);

    const lastPayout = Number(lastPayoutTime);
    
    // IST offset is 5.5 hours = 19800 seconds
    const nowSec = Math.floor(Date.now() / 1000);
    const currentDayIST = Math.floor((nowSec + 19800) / 86400);
    const lastDayIST = Math.floor((lastPayout + 19800) / 86400);

    if (currentDayIST <= lastDayIST) {
      return NextResponse.json({
        status: "skipped",
        reason: "Daily payout interval not elapsed in IST yet",
        currentDayIST,
        lastDayIST,
      });
    }

    // 2. Determine the day of the last payout in IST, and sum all rerolls since that day
    const lastPayoutDateIST = new Date((lastPayout + 19800) * 1000);
    const lpY = lastPayoutDateIST.getUTCFullYear();
    const lpM = String(lastPayoutDateIST.getUTCMonth() + 1).padStart(2, '0');
    const lpD = String(lastPayoutDateIST.getUTCDate()).padStart(2, '0');
    const lastPayoutDayStr = `${lpY}-${lpM}-${lpD}`;

    let rerollsCount = 0;
    try {
      const serverSupabase = require("@/lib/supabase-server").getServerClient();
      if (serverSupabase) {
        const { data: rerollsData } = await serverSupabase
          .from("daily_rerolls")
          .select("day, count")
          .gte("day", lastPayoutDayStr);
        if (rerollsData) {
          rerollsCount = rerollsData.reduce((sum, item) => sum + Number(item.count || 0), 0);
        }
      }
    } catch (err) {
      console.error("Failed to query daily_rerolls from Supabase:", err);
    }

    const targetPrizePoolEth = rerollsCount * 0.005;
    const targetPrizePoolWei = parseEther(targetPrizePoolEth.toFixed(8));

    let txHash = null;
    let fundedAmount = "0";

    const entriesNum = Number(entriesCount);

    if (entriesNum > 0) {
      // There is a winner! Check current contract prizePool
      const currentPrizePoolWei = await contract.prizePool();
      if (targetPrizePoolWei > currentPrizePoolWei) {
        const diffWei = targetPrizePoolWei - currentPrizePoolWei;
        fundedAmount = diffWei.toString();
        // Fund the contract
        const fundTx = await contract.fundPrizePool({ value: diffWei });
        await fundTx.wait();
      }

      // Distribute prize
      const distTx = await contract.distributePrize();
      const receipt = await distTx.wait();
      txHash = receipt.hash;
    } else {
      // No entries/winner: "if no winner the prize gets 0 and we earn everything"
      // If there is any on-chain prizePool, calling distributePrize will sweep it to houseBalance
      const currentPrizePoolWei = await contract.prizePool();
      if (currentPrizePoolWei > 0n) {
        const distTx = await contract.distributePrize();
        const receipt = await distTx.wait();
        txHash = receipt.hash;
      }
    }

    // Mark unsettled credit_spends as settled
    try {
      const serverSupabase = require("@/lib/supabase-server").getServerClient();
      if (serverSupabase) {
        await serverSupabase
          .from("credit_spends")
          .update({ settled: true })
          .eq("settled", false);
      }
    } catch (dbErr) {
      console.error("Failed to update credit_spends in DB:", dbErr);
    }

    return NextResponse.json({
      status: "success",
      day: lastPayoutDayStr,
      entriesCount: entriesNum,
      rerollsCount,
      prizePoolMon: targetPrizePoolEth,
      fundedAmountWei: fundedAmount,
      txHash,
    });
  } catch (error) {
    console.error("[/api/cron/settle-prize] Error:", error);
    return NextResponse.json(
      { error: "Prize settlement failed", details: error.message },
      { status: 500 }
    );
  }
}
