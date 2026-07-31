import { NextResponse } from "next/server";
import { getChallenge, updateChallengeStatus } from "@/lib/duel-store";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  try {
    const { duelId } = params;
    const challenge = await getChallenge(duelId);
    return NextResponse.json({ challenge });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to load challenge", details: error.message },
      { status: 500 }
    );
  }
}

export async function PATCH(request, { params }) {
  try {
    const { duelId } = params;
    const body = await request.json();
    if (!body?.status) {
      return NextResponse.json({ error: "Missing status" }, { status: 400 });
    }

    const challenge = await updateChallengeStatus(duelId, body.status);
    return NextResponse.json({ challenge });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to update challenge", details: error.message },
      { status: 500 }
    );
  }
}
