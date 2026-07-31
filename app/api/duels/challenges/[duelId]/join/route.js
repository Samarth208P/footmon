import { NextResponse } from "next/server";
import { createEvent, joinChallenge } from "@/lib/duel-store";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  try {
    const { duelId } = params;
    const body = await request.json();
    if (!body?.joiner) {
      return NextResponse.json({ error: "Missing joiner address" }, { status: 400 });
    }

    const challenge = await joinChallenge(duelId, body.joiner);
    if (!challenge) {
      return NextResponse.json({ error: "Challenge is no longer open" }, { status: 409 });
    }

    await createEvent({
      duelId,
      sender: body.joiner,
      type: "challenge_joined",
      payload: { joiner: body.joiner },
    });

    return NextResponse.json({ challenge });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to join challenge", details: error.message },
      { status: 500 }
    );
  }
}
