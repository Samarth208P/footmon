import { NextResponse } from "next/server";
import { createEvent, listEvents } from "@/lib/duel-store";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const duelId = searchParams.get("duelId");
    const after = Number(searchParams.get("after") || 0);

    if (!duelId) {
      return NextResponse.json({ error: "Missing duelId" }, { status: 400 });
    }

    const events = await listEvents(duelId, after);
    return NextResponse.json({ events });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to list events", details: error.message },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    if (!body?.duelId || !body?.sender || !body?.type) {
      return NextResponse.json({ error: "Missing required event fields" }, { status: 400 });
    }

    const event = await createEvent(body);
    return NextResponse.json({ event });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to create event", details: error.message },
      { status: 500 }
    );
  }
}
