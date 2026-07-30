# Implementation Plan — 1v1 Draft Duels (Session Wallets)

We will build the **1v1 Draft Duels** mode as a peer-to-peer on-chain game. To avoid MetaMask popups on every draft pick, we will use **client-side Session Wallets (Solution A)**.

The entire gameplay loop will run serverless and client-side, using the existing smart contract structure to mediate deposits and final payout resolutions.

---

## Technical Architecture & Zero-Popup Flow

```
1. STAKE (MetaMask Popup) 
   -> User locks MON stake in Contract.
   -> App generates local Session Wallet (private key stored in sessionStorage).
   -> User signs a single delegation message authorizing the Session Wallet.

2. REAL-TIME DRAFTING (Zero Popups)
   -> Players alternate rolling & picking.
   -> Local session wallet signs picks automatically in the background.
   -> Picks are synced via public peer-to-peer channels (e.g. GunDB, Waku, or simple client-side coordination).

3. CLAIM PAYOUT (MetaMask Popup)
   -> Winner submits both signed draft sheets to the Contract.
   -> Contract verifies signatures of authorized session keys, checks final scores, and payouts the MON.
```

---

## Proposed UI Screens

### 1. Duel Lobby

- **Lobby View:** Create a duel challenge with customizable entry stakes (e.g. `0.5 MON`, `1 MON`), and browse active duel listings.
- **Join Action:** Clicking "Join" requests a matching deposit transaction from MetaMask.

### 2. Dual-Pitch Drafting Table (Split-Screen Layout)

- **Top Stats Bar:** Live comparison of `AVG`, `ATK`, and `DEF` ratings. The leading player's panel glows gold.
- **Pitches Side-by-Side:**
  - **Left Pitch:** Your squad and active selection slots.
  - **Right Pitch:** Opponent's squad preview updating live as they place cards.
- **Status Indicator:** Cleary displays `[ YOUR DRAFT TURN ]` or `[ OPPONENT DRAFTING... ]` with a countdown timer.

---

## Proposed Changes

### Frontend Files

#### [MODIFY] [index.html](file:///c:/Users/gujja/footmon/index.html)

- Add a toggle in the navbar to switch between **Single Player** and **1v1 Duels**.
- Create `#screenDuelLobby` panel.
- Create `#screenDuelPlay` (Split screen layout with live stats head-to-head comparison).

#### [MODIFY] [style.css](file:///c:/Users/gujja/footmon/style.css)

- Implement split-pitch CSS classes (`.duel-split-container`).
- Style lobby cards, status bars, and active turn highlights.

#### [NEW] [js/duel.js](file:///c:/Users/gujja/footmon/js/duel.js)

Create the core manager for duel states:

- Generate local session keys and manage delegation signatures.
- Coordinate client-to-client message relays (using free decentralized Pub/Sub relays like Nostr/Waku).
- Handle on-chain transaction monitoring for staking and payout resolution.

---

## Verification Plan

### Manual Verification

1. Open two browser tabs connected to two different local MetaMask accounts.
2. Account 1 creates a duel challenge (stakes MON).
3. Account 2 joins the challenge (stakes matching MON).
4. Perform alternating drafts in both tabs: verify that all choices sync in real time with **zero MetaMask popups** during picks.
5. Once both pitches are filled, confirm that the higher scorecard score wins and can claim the 70/30 pool payout.
