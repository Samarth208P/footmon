import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

import { getRoomByCode, updateRoom, upsertSquad } from "@/lib/duel-store";
import { isValidRoomCode, normaliseRoomCode } from "@/lib/room-code";
import { authoriseRoomRequest } from "@/lib/session";
import {
  DUEL_FORMATION,
  DUEL_FORMATIONS,
  nextTurnDeadline,
  readyDeadline,
} from "@/lib/draft";
import {
  DUEL_STATUS,
  isChainConfigured,
  readDuel,
} from "@/lib/chain";

export const dynamic = "force-dynamic";

/**
 * POST /api/duels/rooms/:code/ready
 *
 * Marks the caller ready. This is where on-chain escrow is verified — the
 * two-step "share code → both ready" flow means neither player commits money
 * until they are both in the room and both willing to play.
 *
 * The caller must have already escrowed their side on-chain (createDuel for
 * the creator, joinDuel for the joiner) BEFORE hitting this endpoint. Every
 * duel is staked; a room without a valid on-chain escrow is rejected here.
 *
 * The draft begins the moment both sides are ready; the draft/match seeds are
 * written at that instant so the match is reproducible from stored state.
 *
 * Requires a duel session token (Authorization: Bearer ...).
 */
export async function POST(request, { params }) {
  const { code } = await params;
  const roomCode = normaliseRoomCode(code);

  if (!isValidRoomCode(roomCode)) {
    return NextResponse.json({ error: "Invalid room code" }, { status: 400 });
  }

  // Parse optional body — formation choice is submitted with the ready call.
  let body = {};
  try {
    body = await request.json();
  } catch {
    // Body is optional for backwards compatibility (pre-formation clients).
  }

  // Validate formation choice. Default to 4-3-3 if not provided.
  const chosenFormation = body?.formation || DUEL_FORMATION;
  if (!DUEL_FORMATIONS.includes(chosenFormation)) {
    return NextResponse.json(
      { error: `Invalid formation. Choose one of: ${DUEL_FORMATIONS.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const room = await getRoomByCode(roomCode);
    if (!room) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 });
    }

    const auth = authoriseRoomRequest(request, room.id);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    const player = auth.address;

    if (!room.joiner) {
      return NextResponse.json({ error: "The duel has no opponent yet" }, { status: 409 });
    }
    if (!["full", "ready"].includes(room.status)) {
      return NextResponse.json(
        { error: `Cannot ready up while the duel is '${room.status}'` },
        { status: 409 }
      );
    }

    const isCreator = room.creator === player;
    const isJoiner = room.joiner === player;
    if (!isCreator && !isJoiner) {
      return NextResponse.json({ error: "You are not in this duel" }, { status: 403 });
    }

    // ── On-chain escrow check ─────────────────────────────────────────────
    // Every duel is staked, so every ready call must be backed by an on-chain
    // escrow from the caller. If the chain is unreachable we fail closed —
    // ready cannot proceed without a verified stake.
    if (!isChainConfigured()) {
      return NextResponse.json(
        { error: "NEXT_PUBLIC_CONTRACT_ADDRESS is not configured on the server" },
        { status: 503 }
      );
    }
    const stakeWei = BigInt(room.stake ?? "0");
    if (stakeWei <= 0n) {
      return NextResponse.json({ error: "Room has no stake" }, { status: 409 });
    }
    const check = await verifyEscrowFor({
      duelId: room.duel_id,
      side: isCreator ? "creator" : "joiner",
      address: player,
      expectedStake: stakeWei,
    });
    if (!check.ok) {
      return NextResponse.json({ error: check.error }, { status: 409 });
    }

    const patch = isCreator
      ? { creator_ready: true, creator_formation: chosenFormation }
      : { joiner_ready: true, joiner_formation: chosenFormation };

    // Start the ready countdown on the first ready, so a no-show opponent can
    // be refunded rather than leaving the stake stuck.
    if (!room.ready_deadline) {
      patch.ready_deadline = readyDeadline();
    }

    const bothReady =
      (isCreator ? true : room.creator_ready) && (isJoiner ? true : room.joiner_ready);

    if (bothReady) {
      patch.status = "drafting";
      patch.current_turn = room.creator; // creator picks first
      patch.turn_deadline = nextTurnDeadline();
      // Reset the turn-timeout state to a fresh draft: no attempts made,
      // no penalties carried over. (New rooms should already be at zero
      // by column default, but a re-ready path could otherwise reuse
      // stale values.)
      patch.pick_attempts = 0;
      patch.creator_penalty_max_rating = null;
      patch.joiner_penalty_max_rating = null;
      // Seeds recorded BEFORE any pick, so the result can be re-derived later.
      patch.draft_seed = room.draft_seed || randomBytes(16).toString("hex");
      patch.match_seed = room.match_seed || randomBytes(16).toString("hex");
    } else if (room.status === "full") {
      // One side is ready: a distinct state so the UI can say "waiting for your
      // opponent to ready up" rather than showing nothing.
      patch.status = "ready";
    }

    const updated = await updateRoom(room.id, patch);

    // Ensure both squad rows exist so picks have somewhere to land.
    // Each player's formation is stored per-squad so the engine can use it.
    if (bothReady) {
      // The current caller's formation is from this request body;
      // the opponent's formation was stored when THEY readied up.
      // If both ready simultaneously (rare race), both get their own choice.
      const creatorFormation = isCreator ? chosenFormation : (room.creator_formation || DUEL_FORMATION);
      const joinerFormation = isJoiner ? chosenFormation : (room.joiner_formation || DUEL_FORMATION);
      await Promise.all([
        upsertSquad({ roomId: room.id, player: room.creator, formation: creatorFormation }),
        upsertSquad({ roomId: room.id, player: room.joiner, formation: joinerFormation }),
      ]);
    }

    return NextResponse.json({
      room: updated,
      bothReady,
      started: bothReady,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to ready up", details: error.message },
      { status: 500 }
    );
  }
}

/**
 * Confirms that `address` has escrowed on their side of `duelId`, and that
 * the stake matches what the room advertised.
 *
 * Creator side: chain status must be OPEN (creator alone) or FULL (both in).
 * Joiner side:  chain status must be FULL and the joiner address must match.
 */
async function verifyEscrowFor({ duelId, side, address, expectedStake }) {
  let duel;
  try {
    duel = await readDuel(duelId);
  } catch (err) {
    return { ok: false, error: `Could not read duel from chain: ${err.message}` };
  }

  if (duel.status === DUEL_STATUS.NONE) {
    return { ok: false, error: "You have not escrowed on-chain yet" };
  }
  if (duel.stake !== expectedStake) {
    return {
      ok: false,
      error: "On-chain stake does not match this room's stake",
    };
  }

  if (side === "creator") {
    if (
      duel.status !== DUEL_STATUS.OPEN &&
      duel.status !== DUEL_STATUS.FULL
    ) {
      return { ok: false, error: "Duel is not open on-chain" };
    }
    if (duel.creator !== String(address).toLowerCase()) {
      return { ok: false, error: "On-chain creator does not match" };
    }
    return { ok: true };
  }

  // side === "joiner"
  if (duel.status !== DUEL_STATUS.FULL) {
    return { ok: false, error: "You have not escrowed your side yet" };
  }
  if (duel.joiner !== String(address).toLowerCase()) {
    return { ok: false, error: "On-chain joiner does not match" };
  }
  return { ok: true };
}
