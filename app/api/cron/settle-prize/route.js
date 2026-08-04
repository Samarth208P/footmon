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

    // 2. Determine yesterday's date string in IST
    const yesterdayIST = new Date(Date.now() + (5.5 * 60 * 60 * 1000) - (24 * 60 * 60 * 1000));
    const yyyy = yesterdayIST.getUTCFullYear();
    const mm = String(yesterdayIST.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(yesterdayIST.getUTCDate()).padStart(2, '0');
    const yesterdayStr = `${yyyy}-${mm}-${dd}`;

    // 3. Get yesterday's rerolls count
    const rerollsCount = await getDailyRerollsCountForDay(yesterdayStr);
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

    // Log the settlement to Supabase prize_settlements audit log!
    let loggedRow = null;
    try {
      const serverSupabase = require("@/lib/supabase-server").getServerClient();
      if (serverSupabase) {
        const { data, error } = await serverSupabase
          .from("prize_settlements")
          .insert({
            credits_spent: rerollsCount,
            amount_mon: targetPrizePoolEth,
            tx_hash: txHash,
          })
          .select()
          .single();
        if (!error) {
          loggedRow = data;
        }
      }
    } catch (dbErr) {
      console.error("Failed to log prize settlement to DB:", dbErr);
    }

    return NextResponse.json({
      status: "success",
      day: yesterdayStr,
      entriesCount: entriesNum,
      rerollsCount,
      prizePoolMon: targetPrizePoolEth,
      fundedAmountWei: fundedAmount,
      txHash,
      loggedRow,
    });

  } catch (error) {
    console.error("[/api/cron/settle-prize] Error:", error);
    return NextResponse.json(
      { error: "Prize settlement failed", details: error.message },
      { status: 500 }
    );
  }
}
