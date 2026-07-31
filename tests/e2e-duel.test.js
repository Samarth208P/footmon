import { afterAll, describe, expect, it } from "vitest";
import { JsonRpcProvider, Wallet, Contract, parseEther, formatEther } from "ethers";
import { createClient } from "@supabase/supabase-js";

import { POST as createRoomRoute } from "@/app/api/duels/rooms/route";
import { POST as joinRoomRoute } from "@/app/api/duels/rooms/[code]/join/route";
import { POST as sessionRoute } from "@/app/api/duels/rooms/[code]/session/route";
import { POST as readyRoute } from "@/app/api/duels/rooms/[code]/ready/route";
import { POST as pickRoute } from "@/app/api/duels/rooms/[code]/pick/route";
import { POST as simulateRoute } from "@/app/api/duels/rooms/[code]/simulate/route";
import { GET as getRoomRoute } from "@/app/api/duels/rooms/[code]/route";
import { buildSessionMessage } from "@/lib/session";
import { DUEL_SLOTS } from "@/lib/draft";
import { FOOTMON_DUEL_ABI } from "@/lib/chain";

/**
 * End-to-end duel against the REAL Monad testnet contract and the REAL Supabase
 * project. No mocks. Spends a small amount of testnet MON.
 *
 * Opt in with E2E_DUEL=1 so the normal suite stays fast and offline-safe.
 */
const enabled = process.env.E2E_DUEL === "1";
const configured =
  Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) &&
  /^0x[0-9a-fA-F]{40}$/.test(process.env.CONTRACT_ADDRESS || "") &&
  /^0x[0-9a-fA-F]{64}$/.test(process.env.RESOLVER_PRIVATE_KEY || "");

if (enabled && !configured) {
  console.error("\n[e2e-duel] E2E_DUEL=1 but chain/Supabase env is incomplete.\n");
}

const STAKE_MON = "0.002";

const randHex = (n) =>
  Array.from({ length: n }, () => "0123456789abcdef".charAt(Math.floor(Math.random() * 16))).join("");

const jsonRequest = (body, headers = {}) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });

const params = (code) => ({ params: Promise.resolve({ code }) });
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

describe.skipIf(!enabled || !configured)("end-to-end duel (live chain)", () => {
  const provider = new JsonRpcProvider(process.env.MONAD_RPC_URL, undefined, {
    staticNetwork: true,
  });
  const resolver = new Wallet(process.env.RESOLVER_PRIVATE_KEY, provider);
  const contractAddress = process.env.CONTRACT_ADDRESS;

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const createdRooms = [];
  afterAll(async () => {
    for (const id of createdRooms) await admin.from("duel_rooms").delete().eq("id", id);
  });

  it(
    "escrows both stakes, drafts, simulates, settles and pays the winner",
    async () => {
      // ── Fund two throwaway players from the resolver ──────────────────────
      const alice = Wallet.createRandom().connect(provider);
      const bob = Wallet.createRandom().connect(provider);

      for (const player of [alice, bob]) {
        const tx = await resolver.sendTransaction({
          to: player.address,
          value: parseEther("0.06"),
        });
        await tx.wait();
      }

      const aliceContract = new Contract(contractAddress, FOOTMON_DUEL_ABI, alice);
      const bobContract = new Contract(contractAddress, FOOTMON_DUEL_ABI, bob);
      const readContract = new Contract(contractAddress, FOOTMON_DUEL_ABI, provider);

      // ── Alice escrows her stake on-chain ─────────────────────────────────
      const duelId = `0x${randHex(64)}`;
      const stakeWei = parseEther(STAKE_MON);

      await (await aliceContract.createDuel(duelId, { value: stakeWei })).wait();

      let onChain = await readContract.getDuel(duelId);
      expect(Number(onChain.status)).toBe(1); // Open
      expect(onChain.creator.toLowerCase()).toBe(alice.address.toLowerCase());

      // ── Register the room (server verifies escrow on-chain) ──────────────
      const created = await createRoomRoute(
        jsonRequest({ duelId, creator: alice.address })
      );
      expect(created.status).toBe(201);
      const room = (await created.json()).room;
      createdRooms.push(room.id);
      const code = room.room_code;

      // Stake was read from the chain, not trusted from the client.
      expect(String(room.stake)).toBe(stakeWei.toString());

      // ── Bob matches the stake on-chain, then claims the seat ─────────────
      await (await bobContract.joinDuel(duelId, { value: stakeWei })).wait();

      onChain = await readContract.getDuel(duelId);
      expect(Number(onChain.status)).toBe(2); // Full

      const contractBalance = await provider.getBalance(contractAddress);
      expect(contractBalance >= stakeWei * 2n).toBe(true);

      const joined = await joinRoomRoute(jsonRequest({ joiner: bob.address }), params(code));
      expect(joined.status).toBe(200);

      // ── Sessions (one signature each) ────────────────────────────────────
      const openSession = async (wallet) => {
        const payload = {
          address: wallet.address,
          roomCode: code,
          issuedAt: new Date().toISOString(),
          nonce: randHex(32),
        };
        const signature = await wallet.signMessage(buildSessionMessage(payload));
        const res = await sessionRoute(jsonRequest({ ...payload, signature }), params(code));
        expect(res.status).toBe(200);
        return (await res.json()).token;
      };

      const aliceToken = await openSession(alice);
      const bobToken = await openSession(bob);

      // ── Ready check ──────────────────────────────────────────────────────
      await readyRoute(jsonRequest({}, bearer(aliceToken)), params(code));
      const startRes = await readyRoute(jsonRequest({}, bearer(bobToken)), params(code));
      const started = await startRes.json();
      expect(started.room.status).toBe("drafting");
      expect(started.room.match_seed).toBeTruthy();

      // ── Full 22-pick draft, alternating ──────────────────────────────────
      for (let turn = 0; turn < DUEL_SLOTS.length * 2; turn++) {
        const isAlice = turn % 2 === 0;
        const slotIndex = Math.floor(turn / 2);
        const pos = DUEL_SLOTS[slotIndex];

        const res = await pickRoute(
          jsonRequest(
            {
              slotIndex,
              playerName: `${isAlice ? "A" : "B"}-${pos}-${slotIndex}`,
              playerPositions: pos,
              playerRating: 70 + (isAlice ? 12 : 0), // Alice's XI is stronger
              nation: isAlice ? "BRA" : "ITA",
              year: isAlice ? 1970 : 1982,
            },
            bearer(isAlice ? aliceToken : bobToken)
          ),
          params(code)
        );
        expect(res.status, `pick ${turn} failed`).toBe(200);
      }

      const afterDraft = await (
        await getRoomRoute(new Request("http://localhost"), params(code))
      ).json();
      expect(afterDraft.room.status).toBe("simulating");

      // ── Simulate + settle ────────────────────────────────────────────────
      const simRes = await simulateRoute(jsonRequest({}, bearer(aliceToken)), params(code));
      expect(simRes.status).toBe(200);
      const sim = await simRes.json();

      expect(sim.matchLogs.length).toBeGreaterThan(2);
      expect(sim.matchLogs.some((l) => l.event_type === "kickoff")).toBe(true);
      expect(sim.matchLogs.some((l) => l.event_type === "full_time")).toBe(true);

      // Every goal is credited to a player from the scoring side.
      for (const goal of sim.matchLogs.filter((l) => l.event_type === "goal")) {
        expect(goal.scorer_name).toBeTruthy();
        expect(goal.scorer_name.startsWith(goal.team === "creator" ? "A-" : "B-")).toBe(true);
      }

      expect(sim.settled, `settlement failed: ${sim.settlementError}`).toBe(true);
      expect(sim.room.status).toBe("complete");
      expect(sim.room.resolver_tx).toBeTruthy();

      // ── On-chain settlement ──────────────────────────────────────────────
      onChain = await readContract.getDuel(duelId);
      expect(Number(onChain.status)).toBe(3); // Resolved

      const isDraw = Boolean(sim.room.is_draw);
      const housePct = await readContract.duelHousePct();
      const pot = stakeWei * 2n;

      if (isDraw) {
        // Draws refund both stakes with no rake.
        expect(await readContract.pendingClaims(alice.address)).toBe(stakeWei);
        expect(await readContract.pendingClaims(bob.address)).toBe(stakeWei);
      } else {
        const expectedPayout = pot - (pot * housePct) / 100n;
        const winner = sim.room.winner;
        const loser =
          winner === alice.address.toLowerCase() ? bob.address : alice.address;

        expect(await readContract.pendingClaims(winner)).toBe(expectedPayout);
        expect(await readContract.pendingClaims(loser)).toBe(0n);

        // ── Winner pulls the payout ─────────────────────────────────────
        const winnerWallet =
          winner === alice.address.toLowerCase() ? alice : bob;
        const before = await provider.getBalance(winnerWallet.address);

        const winnerContract = new Contract(contractAddress, FOOTMON_DUEL_ABI, winnerWallet);
        const claimTx = await winnerContract.claimDuelPrize();
        const claimReceipt = await claimTx.wait();

        const after = await provider.getBalance(winnerWallet.address);

        // Monad testnet gas at ~200 gwei can exceed a small stake, so raw balance
        // may fall. Assert the exact accounting instead: balance moved by the
        // payout minus the gas actually burned.
        const gasCost = claimReceipt.gasUsed * claimReceipt.gasPrice;
        expect(after - before).toBe(expectedPayout - gasCost);

        // The escrow ledger is cleared, which is the real proof of payment.
        expect(await readContract.pendingClaims(winner)).toBe(0n);

        console.log(
          `[e2e] ${sim.room.score_creator}-${sim.room.score_joiner}, ` +
            `payout ${formatEther(expectedPayout)} MON claimed ` +
            `(gas ${formatEther(gasCost)} MON), tx ${sim.room.resolver_tx}`
        );
      }

      // ── Leaderboard updated ──────────────────────────────────────────────
      const { data: board } = await admin
        .from("duel_leaderboard")
        .select("address, wins, losses, draws, goals_for, goals_against")
        .in("address", [alice.address.toLowerCase(), bob.address.toLowerCase()]);

      expect(board.length).toBe(2);
      const totalGames = board.reduce((s, r) => s + r.wins + r.losses + r.draws, 0);
      expect(totalGames).toBe(2); // one result recorded per player
    },
    600000
  );
});
