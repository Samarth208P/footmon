import { NextResponse } from "next/server";
import { createChallenge, listOpenChallenges } from "@/lib/duel-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const challenges = await listOpenChallenges();
    return NextResponse.json({ challenges });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to list challenges", details: error.message },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    if (!body?.duelId || !body?.creator || !body?.stake || !body?.sessionPubKey) {
      return NextResponse.json({ error: "Missing required challenge fields" }, { status: 400 });
    }

    const challenge = await createChallenge(body);
    return NextResponse.json({ challenge });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to create challenge", details: error.message },
      { status: 500 }
    );
  }
}
