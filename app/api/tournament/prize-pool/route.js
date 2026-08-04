import { NextResponse } from "next/server";
import { getDailyRerollsCount } from "@/lib/duel-store";

export const dynamic = "force-dynamic";

function getSecondsUntilNextISTMidnight() {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  const istDate = new Date(istMs);
  
  const targetDate = new Date(istDate);
  targetDate.setUTCHours(24, 0, 0, 0); // Next UTC midnight of istDate
  
  return Math.max(0, Math.floor((targetDate.getTime() - istDate.getTime()) / 1000));
}

export async function GET() {
  try {
    const count = await getDailyRerollsCount();
    // 0.005 MON per reroll
    const prizePool = count * 0.005;
    const timeUntilPayout = getSecondsUntilNextISTMidnight();

    return NextResponse.json({
      prizePool: prizePool.toString(),
      timeUntilPayout,
    });
  } catch (error) {
    console.error("[/api/tournament/prize-pool] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch prize pool", details: error.message },
      { status: 500 }
    );
  }
}
