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

    // ─── State ───────────────────────────────────────────────────────────────

    address public owner;

    uint256 public rollPrice      = 0.001 ether;   // MON per paid roll
    uint256 public prizePoolPct   = 50;             // % of roll revenue → prize
    uint256 public payoutInterval = 3600;           // seconds between payouts
    uint256 public lastPayoutTime;
    uint256 public prizePool;
    uint256 public roundNumber;

    Entry[] public entries;

    mapping(address => bool)    public hasEntry;
    mapping(address => uint256) public entryIndex;    // 1-indexed into entries[]
    mapping(address => uint256) public pendingClaims; // pull-payment winners
    uint256 public totalPendingClaims; // Tracks total locked claims

    // ─── Events ──────────────────────────────────────────────────────────────

    event RollPurchased (address indexed player, uint256 amount);
    event ScoreSubmitted(address indexed player, uint256 score,
                         string nation, uint16 year, string formation);
    event PrizeAllocated(address indexed winner, uint256 amount, uint256 round);
    event PrizeClaimed  (address indexed winner, uint256 amount);
    event ConfigUpdated (string param, uint256 value);

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "FootMon: not owner");
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor() {
        owner         = msg.sender;
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
        totalPendingClaims += prize;

        emit PrizeAllocated(winner, prize, round);
    }

    /**
     * @notice Winners call this to withdraw their allocated prize.
     */
    function claimPrize() external {
        uint256 amount = pendingClaims[msg.sender];
        require(amount > 0, "FootMon: nothing to claim");

        pendingClaims[msg.sender] = 0;
        totalPendingClaims -= amount;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "FootMon: transfer failed");

        emit PrizeClaimed(msg.sender, amount);
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

    /** @notice Only callable when no player entries exist (truly unused). */
    function emergencyWithdraw() external onlyOwner {
        require(entries.length == 0, "FootMon: has entries");
        uint256 bal = address(this).balance;
        (bool ok,) = payable(owner).call{value: bal}("");
        require(ok, "FootMon: withdraw failed");
    }

    /** @notice Direct MON deposits go to the contract balance. */
    receive() external payable {
        // Funds sit in address(this).balance without inflating prizePool
    }

    /** @notice Withdraw non-prize MON from the contract balance. */
    function ownerWithdraw(uint256 amount) external onlyOwner {
        uint256 locked = prizePool + totalPendingClaims;
        require(address(this).balance - locked >= amount, "FootMon: insufficient non-prize balance");
        (bool ok,) = payable(owner).call{value: amount}("");
        require(ok, "FootMon: withdraw failed");
    }
}
