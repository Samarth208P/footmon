// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title FootMon
 * @notice World Cup squad-building game with hourly on-chain prize distribution
 * @dev Deploy on Monad Testnet (chainId: 10143)
 */
contract FootMon {

    // ─── Structs ─────────────────────────────────────────────────────────────

    struct Entry {
        address player;
        uint256 score;       // avgRating × 100  (e.g. 8250 = avg 82.50)
        uint256 timestamp;
        string  nation;      // ISO-3 code, e.g. "BRA"
        uint16  year;        // World Cup year
        string  formation;   // e.g. "4-3-3"
    }

    /// @dev Lifecycle of a 1v1 staked duel.
    enum DuelStatus {
        None,       // 0 — never created
        Open,       // 1 — creator staked, waiting for an opponent
        Full,       // 2 — both staked, awaiting resolver
        Resolved,   // 3 — winner credited
        Cancelled,  // 4 — creator cancelled before anyone joined
        Refunded    // 5 — timed out or emergency-refunded
    }

    struct Duel {
        address    creator;
        address    joiner;
        uint256    stake;      // per-player stake; pot = stake * 2 when Full
        uint64     createdAt;
        DuelStatus status;
    }

    // ─── State ───────────────────────────────────────────────────────────────

    address public owner;

    uint256 public rollPrice      = 0.01 ether;    // MON per paid roll
    uint256 public prizePoolPct   = 50;             // % of roll revenue → prize
    uint256 public payoutInterval = 86400;          // seconds between payouts (daily)
    uint256 public lastPayoutTime;
    uint256 public prizePool;
    uint256 public roundNumber;

    Entry[] public entries;

    mapping(address => bool)    public hasEntry;
    mapping(address => uint256) public entryIndex;    // 1-indexed into entries[]
    mapping(address => uint256) public pendingClaims; // pull-payment winners

    // ─── Duel State ──────────────────────────────────────────────────────────

    /// @notice Server-held signer authorised to declare duel winners.
    address public resolver;

    /// @notice % of a resolved duel pot kept by the house. Remainder → winner.
    uint256 public duelHousePct = 30;

    /// @notice After this long, an unresolved duel can be refunded by anyone.
    uint256 public duelExpiry = 1 hours;

    /// @notice Blocks new duels without touching in-flight ones.
    bool public duelsPaused;

    mapping(bytes32 => Duel) public duels;

    /// @dev Solvency accounting. Funds tracked here are NOT free balance.
    uint256 public totalEscrowed;       // held for Open/Full duels
    uint256 public totalPendingClaims;  // owed to winners via pendingClaims
    uint256 public houseBalance;        // owner-withdrawable duel rake

    // ─── Events ──────────────────────────────────────────────────────────────

    event RollPurchased (address indexed player, uint256 amount);
    event ScoreSubmitted(address indexed player, uint256 score,
                         string nation, uint16 year, string formation);
    event PrizeAllocated(address indexed winner, uint256 amount, uint256 round);
    event PrizeClaimed  (address indexed winner, uint256 amount);
    event ConfigUpdated (string param, uint256 value);

    event DuelCreated  (bytes32 indexed duelId, address indexed creator, uint256 stake);
    event DuelJoined   (bytes32 indexed duelId, address indexed joiner,  uint256 stake);
    event DuelResolved (bytes32 indexed duelId, address indexed winner,
                        uint256 payout, uint256 houseCut);
    event DuelDrawn    (bytes32 indexed duelId, uint256 refundEach);
    event DuelCancelled(bytes32 indexed duelId, address indexed creator, uint256 refund);
    event DuelRefunded (bytes32 indexed duelId, string reason);
    event ResolverUpdated(address indexed previous, address indexed current);
    event DuelsPaused  (bool paused);
    event HouseWithdrawn(address indexed to, uint256 amount);

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "FootMon: not owner");
        _;
    }

    modifier onlyResolver() {
        require(msg.sender == resolver, "FootMon: not resolver");
        _;
    }

    /// @dev Cheap reentrancy guard. 1 = unlocked, 2 = entered.
    uint256 private _guard = 1;

    modifier nonReentrant() {
        require(_guard == 1, "FootMon: reentrant call");
        _guard = 2;
        _;
        _guard = 1;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor() {
        owner         = msg.sender;
        resolver      = msg.sender;   // owner re-points this post-deploy
        lastPayoutTime = block.timestamp;
        roundNumber   = 1;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Player Functions
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * @notice Pay for one extra roll (client tracks 3 free rolls).
     *         prizePoolPct% of payment goes to prize pool; rest to owner.
     */
    function payForRoll() external payable {
        require(msg.value >= rollPrice, "FootMon: insufficient MON");

        uint256 toPrize = (msg.value * prizePoolPct) / 100;
        prizePool += toPrize;

        uint256 toOwner = msg.value - toPrize;
        if (toOwner > 0) {
            (bool ok,) = payable(owner).call{value: toOwner}("");
            require(ok, "FootMon: owner transfer failed");
        }

        emit RollPurchased(msg.sender, msg.value);
    }

    /**
     * @notice Submit (or update if better) your team score.
     * @param score     avgRating × 100, range 1-10000
     * @param nation    ISO-3 country code
     * @param year      World Cup year (1970-2030)
     * @param formation Formation string
     */
    function submitScore(
        uint256 score,
        string  calldata nation,
        uint16  year,
        string  calldata formation
    ) external {
        require(score > 0 && score <= 10000, "FootMon: invalid score");
        require(year >= 1970 && year <= 2030, "FootMon: invalid year");
        require(bytes(nation).length > 0,     "FootMon: empty nation");

        if (!hasEntry[msg.sender]) {
            entries.push(Entry({
                player:    msg.sender,
                score:     score,
                timestamp: block.timestamp,
                nation:    nation,
                year:      year,
                formation: formation
            }));
            entryIndex[msg.sender] = entries.length; // 1-indexed
            hasEntry[msg.sender]   = true;
        } else {
            uint256 idx = entryIndex[msg.sender] - 1;
            // Only update if this is a higher score
            if (score > entries[idx].score) {
                entries[idx].score     = score;
                entries[idx].timestamp = block.timestamp;
                entries[idx].nation    = nation;
                entries[idx].year      = year;
                entries[idx].formation = formation;
            }
        }

        emit ScoreSubmitted(msg.sender, score, nation, year, formation);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Prize Distribution  (pull-payment pattern for safety)
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * @notice Anyone may call this once the payout interval has elapsed.
     *         Finds the highest-score entry (timestamp breaks ties).
     *         Prize is credited to winner's pendingClaims — NOT pushed.
     */
    function distributePrize() external {
        require(
            block.timestamp >= lastPayoutTime + payoutInterval,
            "FootMon: interval not elapsed"
        );
        require(entries.length > 0, "FootMon: no entries");
        require(prizePool > 0,      "FootMon: empty prize pool");

        uint256 winnerIdx = 0;
        for (uint256 i = 1; i < entries.length; i++) {
            Entry storage curr   = entries[i];
            Entry storage leader = entries[winnerIdx];
            if (
                curr.score > leader.score ||
                (curr.score == leader.score && curr.timestamp < leader.timestamp)
            ) {
                winnerIdx = i;
            }
        }

        address winner  = entries[winnerIdx].player;
        uint256 prize   = prizePool;
        uint256 round   = roundNumber;

        prizePool      = 0;
        lastPayoutTime = block.timestamp;
        roundNumber++;

        pendingClaims[winner] += prize;
        totalPendingClaims    += prize;

        emit PrizeAllocated(winner, prize, round);
    }

    /**
     * @notice Winners call this to withdraw their allocated prize.
     */
    function claimPrize() external nonReentrant {
        _claim(msg.sender);
    }

    /**
     * @notice Duel winners call this to withdraw their escrowed winnings.
     * @dev Same pull-payment ledger as claimPrize(); separate name purely so
     *      the duel UI can present a distinct action.
     */
    function claimDuelPrize() external nonReentrant {
        _claim(msg.sender);
    }

    /**
     * @dev Checks-effects-interactions: zero the ledger before transferring.
     */
    function _claim(address account) private {
        uint256 amount = pendingClaims[account];
        require(amount > 0, "FootMon: nothing to claim");

        pendingClaims[account] = 0;
        totalPendingClaims    -= amount;

        (bool ok,) = payable(account).call{value: amount}("");
        require(ok, "FootMon: transfer failed");

        emit PrizeClaimed(account, amount);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Duel Escrow  (1v1 staked matches, server-authorised resolution)
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * @notice Open a duel and escrow your stake. msg.value sets the stake that
     *         the opponent must match exactly.
     * @param duelId Caller-supplied unique id (the off-chain room id).
     */
    function createDuel(bytes32 duelId) external payable {
        require(!duelsPaused,                          "FootMon: duels paused");
        require(duelId != bytes32(0),                  "FootMon: zero duelId");
        require(msg.value > 0,                         "FootMon: zero stake");
        require(duels[duelId].status == DuelStatus.None, "FootMon: duel exists");

        duels[duelId] = Duel({
            creator:   msg.sender,
            joiner:    address(0),
            stake:     msg.value,
            createdAt: uint64(block.timestamp),
            status:    DuelStatus.Open
        });

        totalEscrowed += msg.value;

        emit DuelCreated(duelId, msg.sender, msg.value);
    }

    /**
     * @notice Match the creator's stake and fill the duel.
     * @dev Rejects self-join and any second joiner.
     */
    function joinDuel(bytes32 duelId) external payable {
        require(!duelsPaused, "FootMon: duels paused");

        Duel storage duel = duels[duelId];
        require(duel.status == DuelStatus.Open,  "FootMon: duel not open");
        require(msg.sender != duel.creator,     "FootMon: cannot self-join");
        require(duel.joiner == address(0),      "FootMon: already joined");
        require(msg.value == duel.stake,        "FootMon: stake mismatch");

        duel.joiner = msg.sender;
        duel.status = DuelStatus.Full;

        totalEscrowed += msg.value;

        emit DuelJoined(duelId, msg.sender, msg.value);
    }

    /**
     * @notice Resolver declares the winner of a filled duel and PUSHES the
     *         payout directly to the winner's wallet in the same transaction.
     *         (100 - duelHousePct)% of the pot goes to the winner; the rake
     *         accrues to houseBalance.
     * @dev Push-payment path. If the winner is a contract wallet that
     *      rejects the transfer (or burns its 60k gas budget), we fall back
     *      to crediting pendingClaims so the funds are never stuck — the
     *      claimDuelPrize() path stays as a safety net. In practice every
     *      EOA winner receives the prize automatically, no wallet action
     *      required from them.
     */
    function resolveDuel(bytes32 duelId, address winner) external onlyResolver nonReentrant {
        Duel storage duel = duels[duelId];
        require(duel.status == DuelStatus.Full, "FootMon: duel not resolvable");
        require(
            winner == duel.creator || winner == duel.joiner,
            "FootMon: winner not a participant"
        );

        uint256 pot      = duel.stake * 2;
        uint256 houseCut = (pot * duelHousePct) / 100;
        uint256 payout   = pot - houseCut;

        // Effects before the external call.
        duel.status = DuelStatus.Resolved;
        totalEscrowed -= pot;
        houseBalance  += houseCut;

        // Bounded gas so a griefing contract-wallet can't consume the whole
        // resolver tx budget. 60 000 is comfortable for typical fallback /
        // receive handlers on a smart-account wallet.
        (bool ok,) = payable(winner).call{value: payout, gas: 60000}("");
        if (!ok) {
            // Push failed — record it and let the winner pull instead.
            pendingClaims[winner] += payout;
            totalPendingClaims    += payout;
        }

        emit DuelResolved(duelId, winner, payout, houseCut);
    }

    /**
     * @notice Resolver declares a draw and PUSHES each player's stake back
     *         to them in the same transaction. The house takes no rake on
     *         a draw.
     * @dev Same push-with-fallback pattern as resolveDuel. Each side is
     *      handled independently so one failing wallet can't strand the
     *      other player's refund.
     */
    function resolveDuelDraw(bytes32 duelId) external onlyResolver nonReentrant {
        Duel storage duel = duels[duelId];
        require(duel.status == DuelStatus.Full, "FootMon: duel not resolvable");

        uint256 stake   = duel.stake;
        address creator = duel.creator;
        address joiner  = duel.joiner;

        duel.status = DuelStatus.Resolved;
        totalEscrowed -= stake * 2;

        (bool okC,) = payable(creator).call{value: stake, gas: 60000}("");
        if (!okC) {
            pendingClaims[creator] += stake;
            totalPendingClaims     += stake;
        }

        (bool okJ,) = payable(joiner).call{value: stake, gas: 60000}("");
        if (!okJ) {
            pendingClaims[joiner] += stake;
            totalPendingClaims    += stake;
        }

        emit DuelDrawn(duelId, stake);
    }

    /**
     * @notice Creator withdraws an unmatched duel and gets their stake back.
     */
    function cancelDuel(bytes32 duelId) external nonReentrant {
        Duel storage duel = duels[duelId];
        require(duel.status == DuelStatus.Open, "FootMon: duel not open");
        require(msg.sender == duel.creator,     "FootMon: not creator");

        uint256 refund = duel.stake;

        duel.status = DuelStatus.Cancelled;   // effects first
        totalEscrowed -= refund;

        (bool ok,) = payable(msg.sender).call{value: refund}("");
        require(ok, "FootMon: refund failed");

        emit DuelCancelled(duelId, msg.sender, refund);
    }

    /**
     * @notice Permissionless timeout reclaim. Callable by anyone once
     *         duelExpiry has elapsed, so funds can never be stranded by a
     *         missing opponent or an offline resolver.
     * @dev Refunds are credited to pendingClaims (pull), so a hostile
     *      participant cannot grief the call by reverting on receive.
     */
    function refundExpiredDuel(bytes32 duelId) external {
        Duel storage duel = duels[duelId];
        require(
            duel.status == DuelStatus.Open || duel.status == DuelStatus.Full,
            "FootMon: duel not active"
        );
        require(
            block.timestamp >= duel.createdAt + duelExpiry,
            "FootMon: not expired"
        );

        _refundDuel(duel, duelId, "expired");
    }

    /**
     * @notice Owner escape hatch: refund an active duel immediately, e.g. if
     *         the resolver is compromised or a match cannot be adjudicated.
     */
    function ownerRefundDuel(bytes32 duelId) external onlyOwner {
        Duel storage duel = duels[duelId];
        require(
            duel.status == DuelStatus.Open || duel.status == DuelStatus.Full,
            "FootMon: duel not active"
        );

        _refundDuel(duel, duelId, "owner refund");
    }

    /**
     * @dev Shared refund path. Returns every staked wei to whoever staked it.
     */
    function _refundDuel(Duel storage duel, bytes32 duelId, string memory reason)
        private
    {
        uint256 stake   = duel.stake;
        address creator = duel.creator;
        address joiner  = duel.joiner;
        bool    wasFull = duel.status == DuelStatus.Full;

        duel.status = DuelStatus.Refunded;   // effects first

        uint256 released        = wasFull ? stake * 2 : stake;
        totalEscrowed          -= released;
        pendingClaims[creator] += stake;
        totalPendingClaims     += stake;

        if (wasFull) {
            pendingClaims[joiner] += stake;
            totalPendingClaims    += stake;
        }

        emit DuelRefunded(duelId, reason);
    }

    // ─── Duel Views ──────────────────────────────────────────────────────────

    function getDuel(bytes32 duelId) external view returns (Duel memory) {
        return duels[duelId];
    }

    function duelStatus(bytes32 duelId) external view returns (DuelStatus) {
        return duels[duelId].status;
    }

    /** @notice Seconds until refundExpiredDuel() becomes callable (0 = now). */
    function timeUntilDuelExpiry(bytes32 duelId) external view returns (uint256) {
        Duel storage duel = duels[duelId];
        if (duel.status != DuelStatus.Open && duel.status != DuelStatus.Full) {
            return 0;
        }
        uint256 expiresAt = duel.createdAt + duelExpiry;
        return block.timestamp >= expiresAt ? 0 : expiresAt - block.timestamp;
    }

    /**
     * @notice Balance not owed to anyone: safe for the owner to withdraw.
     */
    function freeBalance() public view returns (uint256) {
        uint256 encumbered = totalEscrowed + totalPendingClaims + prizePool + houseBalance;
        uint256 bal = address(this).balance;
        return bal > encumbered ? bal - encumbered : 0;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  View Functions
    // ═════════════════════════════════════════════════════════════════════════

    function getEntriesCount() external view returns (uint256) {
        return entries.length;
    }

    function getEntry(uint256 idx) external view returns (Entry memory) {
        require(idx < entries.length, "FootMon: out of bounds");
        return entries[idx];
    }

    /** @notice Seconds until next allowed payout (0 = can distribute now). */
    function getTimeUntilPayout() external view returns (uint256) {
        uint256 next = lastPayoutTime + payoutInterval;
        return block.timestamp >= next ? 0 : next - block.timestamp;
    }

    /** @notice True if distributePrize() would succeed right now. */
    function canDistribute() external view returns (bool) {
        return
            block.timestamp >= lastPayoutTime + payoutInterval &&
            entries.length > 0 &&
            prizePool > 0;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Owner Config
    // ═════════════════════════════════════════════════════════════════════════

    function setRollPrice(uint256 _price) external onlyOwner {
        require(_price > 0, "FootMon: price must be positive");
        rollPrice = _price;
        emit ConfigUpdated("rollPrice", _price);
    }

    function setPrizePoolPct(uint256 _pct) external onlyOwner {
        require(_pct <= 100, "FootMon: max 100");
        prizePoolPct = _pct;
        emit ConfigUpdated("prizePoolPct", _pct);
    }

    /** @dev Minimum 60 s; set to 300 for 5-min demo rounds. */
    function setPayoutInterval(uint256 _interval) external onlyOwner {
        require(_interval >= 60, "FootMon: min 60 seconds");
        payoutInterval = _interval;
        emit ConfigUpdated("payoutInterval", _interval);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "FootMon: zero address");
        owner = newOwner;
    }

    /** @notice Re-point the server-held resolver identity. */
    function setResolver(address newResolver) external onlyOwner {
        require(newResolver != address(0), "FootMon: zero address");
        address previous = resolver;
        resolver = newResolver;
        emit ResolverUpdated(previous, newResolver);
    }

    /** @dev Capped at 50% so the rake can never be set confiscatory. */
    function setDuelHousePct(uint256 _pct) external onlyOwner {
        require(_pct <= 50, "FootMon: max 50");
        duelHousePct = _pct;
        emit ConfigUpdated("duelHousePct", _pct);
    }

    /** @dev Minimum 10 minutes so players cannot be refunded mid-match. */
    function setDuelExpiry(uint256 _seconds) external onlyOwner {
        require(_seconds >= 600, "FootMon: min 600 seconds");
        duelExpiry = _seconds;
        emit ConfigUpdated("duelExpiry", _seconds);
    }

    /**
     * @notice Stop new duels from being created or joined. In-flight duels are
     *         unaffected and remain resolvable, refundable and claimable.
     */
    function setDuelsPaused(bool paused) external onlyOwner {
        duelsPaused = paused;
        emit DuelsPaused(paused);
    }

    /** @notice Withdraw accrued duel rake. */
    function withdrawHouse() external onlyOwner nonReentrant {
        uint256 amount = houseBalance;
        require(amount > 0, "FootMon: no house balance");

        houseBalance = 0;

        (bool ok,) = payable(owner).call{value: amount}("");
        require(ok, "FootMon: withdraw failed");

        emit HouseWithdrawn(owner, amount);
    }

    /**
     * @notice Sweep only unencumbered balance. Escrowed duel stakes, pending
     *         claims, the prize pool and the house rake are never touchable.
     */
    function emergencyWithdraw() external onlyOwner nonReentrant {
        uint256 amount = freeBalance();
        require(amount > 0, "FootMon: nothing free to withdraw");

        (bool ok,) = payable(owner).call{value: amount}("");
        require(ok, "FootMon: withdraw failed");
    }

    /** @notice Direct MON deposits add to prize pool. */
    receive() external payable {
        prizePool += msg.value;
    }
}
