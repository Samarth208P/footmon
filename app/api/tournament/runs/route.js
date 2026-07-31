import { NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { verifyMessage } from "ethers";

import { listTournamentLeaderboard, recordTournamentRun } from "@/lib/duel-store";
import { isValidAddress, normaliseAddress } from "@/lib/username";
import {
  TOURNAMENT_ROUNDS,
  buildTournamentMessage,
  runTournament,
  squadFingerprint,
} from "@/lib/tournament";
import { SQUAD_SIZE, canFillSlot, slotPositionFor } from "@/lib/draft";

export const dynamic = "force-dynamic";

const CLAIM_TTL_MS = 10 * 60 * 1000;
const CLAIM_SKEW_MS = 2 * 60 * 1000;

/** GET /api/tournament/runs — the tournament leaderboard. */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") || 50)));

  try {
    const entries = await listTournamentLeaderboard(limit);
    return NextResponse.json({ entries });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to load tournament leaderboard", details: error.message },
      { status: 500 }
    );
  }
}

/**
 * POST /api/tournament/runs
 *
 * Submits a squad for a solo run. The SERVER simulates all seven rounds and
 * records the outcome; the client only replays it. A client-reported result
 * would make the leaderboard meaningless.
 *
 * Body: { address, players[11], nation?, year?, formation?, issuedAt, nonce, signature }
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const { address, players, nation = null, year = null, formation = null } = body ?? {};

  if (!isValidAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }
  if (!Array.isArray(players) || players.length !== SQUAD_SIZE) {
    return NextResponse.json(
      { error: `A full squad of ${SQUAD_SIZE} players is required` },
      { status: 400 }
    );
  }

  // ── Squad legality ───────────────────────────────────────────────────────
  const names = new Set();
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p || typeof p.name !== "string" || p.name.trim() === "") {
      return NextResponse.json({ error: `Player ${i + 1} has no name` }, { status: 400 });
    }
    if (names.has(p.name)) {
      return NextResponse.json(
        { error: `${p.name} appears more than once` },
        { status: 400 }
      );
    }
    names.add(p.name);

    const rating = Number(p.rating);
    if (!Number.isFinite(rating) || rating < 0 || rating > 100) {
      return NextResponse.json(
        { error: `${p.name} has an invalid rating` },
        { status: 400 }
      );
    }
    if (!canFillSlot(i, p.position ?? p.positions)) {
      return NextResponse.json(
        { error: `${p.name} cannot play ${slotPositionFor(i)}` },
        { status: 400 }
      );
    }
  }

  // ── Signature ────────────────────────────────────────────────────────────
  const { issuedAt, nonce, signature } = body ?? {};
  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }
  if (typeof nonce !== "string" || !/^[0-9a-f]{32}$/i.test(nonce)) {
    return NextResponse.json({ error: "Invalid nonce" }, { status: 400 });
  }

  const ts = Date.parse(issuedAt);
  if (Number.isNaN(ts)) {
    return NextResponse.json({ error: "Invalid Issued At timestamp" }, { status: 400 });
  }
  const now = Date.now();
  if (ts - now > CLAIM_SKEW_MS) {
    return NextResponse.json({ error: "Run is dated in the future" }, { status: 400 });
  }
  if (now - ts > CLAIM_TTL_MS) {
    return NextResponse.json({ error: "Run submission expired, please sign again" }, { status: 400 });
  }

  const squadHash = createHash("sha256").update(squadFingerprint(players)).digest("hex");
  const message = buildTournamentMessage({ address, squadHash, issuedAt, nonce });

  let recovered;
  try {
    recovered = verifyMessage(message, signature);
  } catch {
    return NextResponse.json({ error: "Signature could not be verified" }, { status: 401 });
  }
  if (normaliseAddress(recovered) !== normaliseAddress(address)) {
    return NextResponse.json(
      { error: "Signature does not match the claimed address" },
      { status: 401 }
    );
  }

  // ── Run it ───────────────────────────────────────────────────────────────
  try {
    const seed = randomBytes(16).toString("hex");
    const result = runTournament({
      seed,
      players: players.map((p, i) => ({
        name: p.name,
        position: p.position ?? slotPositionFor(i),
        rating: Number(p.rating),
      })),
    });

    const entry = await recordTournamentRun({
      address: normaliseAddress(address),
      wins: result.wins,
      goalsFor: result.goalsFor,
      goalsAgainst: result.goalsAgainst,
      teamRating: Number(result.teamRating.toFixed(2)),
      nation,
      year: Number.isFinite(Number(year)) ? Number(year) : null,
      formation,
      runSeed: seed,
    });

    return NextResponse.json(
      {
        entry,
        run: result,
        champion: result.champion,
        rounds: TOURNAMENT_ROUNDS,
      },
      { status: 201 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to record tournament run", details: error.message },
      { status: 500 }
    );
  }
}
