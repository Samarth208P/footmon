# FootMon ⚽ · Monad Testnet

**Build your dream World Cup squad. Compete on-chain. Win MON every hour.**

FootMon is a fully on-chain squad-building game where players roll for World Cup nations & years (1970–2026), assemble their best 11-player team from real historical data, and submit their average team rating to a live leaderboard. The highest-rated team at the end of each hourly round wins 50% of the accumulated roll-fee prize pool.

---

## Quick Start

### 1. Run Locally
```bash
# Any static server works (fetch() requires a server, not file://)
python -m http.server 8080
# → open http://localhost:8080
```

### 2. Deploy the Contract
See **[DEPLOY.md](DEPLOY.md)** for full instructions (Remix IDE recommended).

### 3. Set Contract Address
After deployment, open `js/config.js` and set:
```js
const CONTRACT_ADDRESS = "0xYourDeployedAddress";
```

---

## How to Play

| Step | Action |
|------|--------|
| 1 | Pick a **formation** (4-3-3, 4-4-2, etc.) and a **style** (Defensive / Balanced / Attacking) |
| 2 | Click **Start Rolling** — you get a random World Cup nation + year |
| 3 | Use **3 free rerolls** to change the nation or year |
| 4 | Extra rolls cost **0.001 MON** each (paid on-chain via MetaMask) |
| 5 | **Pick players** from the squad list and assign them to pitch slots |
| 6 | Fill all 11 slots → **Submit Score** on Monad Testnet |
| 7 | Check the **Leaderboard** — highest average team rating wins 50% of the prize pool each hour |

---

## Prize Pool

- 50% of every paid roll → prize pool (configurable by owner)
- Hourly payout to the player with the highest average team rating
- Ties broken by earliest submission timestamp
- Winners claim via pull payment (`claimPrize()`) — safe and gas-efficient

---

## Tech Stack

- **Frontend**: Vanilla HTML + CSS + JS (no framework)
- **Blockchain**: Solidity 0.8.20 on [Monad Testnet](https://testnet.monad.xyz) (Chain ID: 10143)
- **Web3 library**: ethers.js v6
- **Data**: Real World Cup squad data (1970–2026) in `/data/*.json`

---

## File Structure

```
footmon/
├── index.html          # Main game UI
├── style.css           # Dark-theme styles
├── js/
│   ├── config.js       # Contract address + formation/position config
│   ├── data.js         # JSON data loader + roll logic
│   ├── wallet.js       # MetaMask + Monad Testnet connection
│   ├── contract.js     # Smart contract ABI + interaction helpers
│   ├── pitch.js        # SVG pitch renderer
│   ├── game.js         # Core game state + logic
│   ├── leaderboard.js  # Leaderboard UI + prize countdown
│   └── main.js         # App bootstrap + event wiring
├── contract/
│   ├── FootMon.sol     # Solidity smart contract
│   └── deploy.js       # Node.js deploy script (optional)
├── data/               # World Cup squad data (1970–2026)
└── DEPLOY.md           # Contract deployment instructions
```

---

## Owner Controls (post-deploy)

| Function | Default | Notes |
|----------|---------|-------|
| `setRollPrice(wei)` | 0.001 MON | Cost per paid roll |
| `setPrizePoolPct(%)` | 50 | % of rolls → prize pool |
| `setPayoutInterval(s)` | 3600 | Seconds between payouts (min 60) |
| `transferOwnership(addr)` | — | Hand off owner role |

Set `setPayoutInterval(300)` for a 5-minute demo round.
