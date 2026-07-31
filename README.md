# FootMon ⚽ · Monad Testnet

**Build your dream World Cup squad. Duel for escrowed MON. Climb the leaderboards.**

FootMon is an on-chain squad-building game. Roll for World Cup nations & years (1970–2026), assemble an XI from real historical data, and either compete on the hourly leaderboard, duel another player 1v1 for a staked pot, or run the solo 7-match eliminator.

---

## Quick Start

```bash
npm install
cp .env.example .env     # then fill in the values
npm run dev              # → http://localhost:3000
```

### Required environment

See [`.env.example`](.env.example). Placeholder names only there — never commit real values.

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Project REST URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret** key (`sb_secret_…`). Server-only. Bypasses RLS. |
| `NEXT_PUBLIC_SUPABASE_URL` | Same URL, exposed to the browser |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Publishable** key (`sb_publishable_…`). Read-only. |
| `SESSION_SECRET` | HMAC secret (≥32 chars) for duel session tokens |
| `RESOLVER_PRIVATE_KEY` | Server signer that settles duels. Never `NEXT_PUBLIC_*`. |
| `DEPLOYER_PRIVATE_KEY` | Contract owner. Kept separate from the resolver. |
| `CONTRACT_ADDRESS` | Deployed FootMon address |
| `MONAD_RPC_URL` | Monad Testnet RPC (chain 10143) |

> **A publishable key in the `SUPABASE_SERVICE_ROLE_KEY` slot will not work.** It is RLS-constrained, so every server write fails and the app silently degrades to in-memory storage. `lib/supabase-server.js` throws loudly if it detects this.

> **Ambient env vars win.** Neither `process.loadEnvFile()` nor Next.js overrides a variable already exported in your shell. If a stale key is exported, it shadows `.env`. Use a clean terminal.

### Database

```bash
npx supabase link --project-ref <your-ref>
npm run db:push
```

### Contract

```bash
forge test                      # 59 tests
forge script contract/script/DeployFootMon.s.sol:DeployFootMon \
  --rpc-url $MONAD_RPC_URL --broadcast
npm run chain:verify            # asserts live wiring + solvency
```

---

## Game Modes

### Hourly leaderboard (solo)
Pick a formation and style, roll nations/years, fill 11 slots, submit your average rating. Highest team at the end of each hour takes 50% of the roll-fee prize pool via `claimPrize()`.

### 1v1 Duels (staked)
1. Create a room — your stake is **escrowed in the contract** via `createDuel()`
2. Share the link, or let someone join from the public lobby. Private rooms need a password.
3. Opponent matches the stake with `joinDuel()`
4. Both ready up, then draft alternately — 11 picks each, server-arbitrated
5. The server simulates 90 minutes from a pre-recorded seed and streams minute ticks to both screens
6. The resolver calls `resolveDuel()`; the winner pulls **70% of the pot** with `claimDuelPrize()` (rake is owner-configurable, capped at 50%)

Stakes are never stranded: `cancelDuel` (pre-join), `refundExpiredDuel` (permissionless after timeout), and an owner emergency refund all return funds.

### Solo tournament (7-match eliminator)
Draft one squad, then face seven AI XIs of rising strength through the same engine. One loss ends the run. Results are ranked by wins → goal difference → team rating.

---

## Architecture

**Money is on-chain; everything else is bookkeeping.** The server never trusts a client's claim about a stake — it reads escrow state from the contract before accepting a room or a join.

**The server is authoritative for anything that decides a winner.** Turn order is *derived* from persisted pick counts (never a stored pointer that a retry could double-advance). Pick legality, position compatibility, match simulation, and forfeits are all server-side. The browser holds only the publishable key, which has `SELECT` and nothing else.

**One signature per duel, not per pick.** A player signs once to open a room session; the server returns a room-scoped HMAC bearer token used for ready/pick/forfeit. A token for one room cannot act in another.

**Match results are reproducible.** The match seed is written *before* the simulation runs, so any disputed result can be re-derived from stored state.

**Realtime is fast but not trusted for durability.** Live traffic rides Supabase Realtime broadcast (~110 ms observed). Because broadcasts are lost while unsubscribed, every event is persisted first and a slow Postgres poll acts as the reconnection safety net. Each event carries a `clientEventId` so the broadcast and durable copies collapse into one — see `public/js/duel-events.js`.

**Room passwords live in a separate table** (`duel_room_secrets`) with zero grants to `anon` and excluded from the Realtime publication, so a hash cannot leak through `select *`, a view, or a change payload.

---

## Tech Stack

- **Frontend**: Next.js app router + browser-side game modules
- **Contract**: Solidity 0.8.20 on [Monad Testnet](https://testnet.monad.xyz) (chain 10143)
- **Chain libs**: ethers v6, Foundry
- **Data**: Supabase Postgres (RLS, Realtime), `@supabase/supabase-js`
- **Tests**: Vitest (234) + Foundry (59)

---

## Testing

```bash
npm run test           # 234 Vitest tests (unit + API integration)
npm run test:contract  # 59 Foundry tests, incl. reentrancy + fuzz
npm run test:all       # both
E2E_DUEL=1 npm run test:e2e   # full duel on live testnet (spends MON)
```

The e2e test drives a complete duel with two throwaway wallets: escrow → room → join → sessions → 22 picks → simulation → on-chain settlement → claim, asserting exact wei accounting throughout.

---

## File Structure

```
footmon/
├── app/
│   ├── page.js                    # app shell (HTML template + script loading)
│   ├── duel/[code]/page.js        # invite links: /duel/<CODE>#pw=<password>
│   └── api/
│       ├── profile/               # username claim (signature-verified) + lookup
│       ├── duels/rooms/           # create/list, [code], join, session,
│       │                          #   ready, pick, forfeit, simulate
│       ├── tournament/runs/       # solo run submission + leaderboard
│       └── leaderboard/           # duel + tournament boards
├── lib/
│   ├── supabase-server.js         # secret-key client, loud on misconfig
│   ├── duel-store.js              # data access + loud in-memory fallback
│   ├── chain.js                   # escrow reads + resolver signer
│   ├── session.js                 # per-room HMAC bearer tokens
│   ├── draft.js                   # turn order + pick legality (pure)
│   ├── match-engine.js            # deterministic seeded simulation (pure)
│   ├── tournament.js              # 7-match eliminator (pure)
│   ├── duel-resolution.js         # simulate → persist → settle
│   ├── password.js                # scrypt room passwords
│   └── username.js                # username rules + claim message
├── public/js/
│   ├── duel-events.js             # event normalisation/dedupe (pure)
│   ├── duel-screen.js             # state → screen mapping (pure)
│   ├── realtime.js                # Supabase Realtime + presence
│   ├── duel-room.js               # room lifecycle + escrow calls
│   ├── match-view.js              # centre-screen match presentation
│   └── profile.js                 # username claim modal + name cache
├── contract/
│   ├── FootMon.sol
│   ├── test/FootMonDuel.t.sol
│   └── script/{DeployFootMon,VerifyFootMon}.s.sol
├── supabase/migrations/
└── tests/
```

---

## Owner Controls

| Function | Default | Notes |
|---|---|---|
| `setRollPrice(wei)` | 0.001 MON | Cost per paid roll |
| `setPrizePoolPct(%)` | 50 | % of rolls → hourly prize |
| `setPayoutInterval(s)` | 3600 | Min 60. Use 300 for a demo round. |
| `setResolver(addr)` | deployer | Server signer for duel results |
| `setDuelHousePct(%)` | 30 | Duel rake. Capped at 50. |
| `setDuelExpiry(s)` | 3600 | Min 600. Timeout before refunds open. |
| `setDuelsPaused(bool)` | false | Blocks new duels; in-flight ones still settle |
| `withdrawHouse()` | — | Withdraw accrued duel rake |
| `emergencyWithdraw()` | — | **Only** unencumbered balance — escrow, pending claims, prize pool and rake are untouchable |
