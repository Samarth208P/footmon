// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FootMon} from "../FootMon.sol";

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// @dev Re-enters claimDuelPrize() from receive() to probe the guard.
contract ReentrantClaimer {
    FootMon public footmon;
    bool public attack = true;
    bool public reentryBlocked;
    bool public reenteredSuccessfully;

    constructor(FootMon _footmon) {
        footmon = _footmon;
    }

    function joinDuel(bytes32 duelId, uint256 stake) external {
        footmon.joinDuel{value: stake}(duelId);
    }

    function claim() external {
        footmon.claimDuelPrize();
    }

    function setAttack(bool value) external {
        attack = value;
    }

    receive() external payable {
        if (attack) {
            attack = false; // one probe only, no infinite recursion
            try footmon.claimDuelPrize() {
                reenteredSuccessfully = true;
            } catch {
                reentryBlocked = true;
            }
        }
    }
}

/// @dev Always rejects incoming MON — used to prove refunds can't be griefed.
contract RevertingReceiver {
    FootMon public footmon;

    constructor(FootMon _footmon) {
        footmon = _footmon;
    }

    function createDuel(bytes32 duelId, uint256 stake) external {
        footmon.createDuel{value: stake}(duelId);
    }

    function cancelDuel(bytes32 duelId) external {
        footmon.cancelDuel(duelId);
    }

    receive() external payable {
        revert("no thanks");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tests
// ─────────────────────────────────────────────────────────────────────────────

contract FootMonDuelTest is Test {
    FootMon internal footmon;

    address internal owner    = address(this);
    address internal resolver = makeAddr("resolver");
    address internal alice    = makeAddr("alice");
    address internal bob      = makeAddr("bob");
    address internal carol    = makeAddr("carol");

    bytes32 internal constant DUEL = keccak256("duel-1");
    uint256 internal constant STAKE = 1 ether;

    function setUp() public {
        footmon = new FootMon();
        footmon.setResolver(resolver);

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _createAndJoin(bytes32 duelId) internal {
        vm.prank(alice);
        footmon.createDuel{value: STAKE}(duelId);
        vm.prank(bob);
        footmon.joinDuel{value: STAKE}(duelId);
    }

    /// @dev Contract must always hold at least everything it owes.
    function _assertSolvent() internal view {
        uint256 owed = footmon.totalEscrowed()
            + footmon.totalPendingClaims()
            + footmon.prizePool()
            + footmon.houseBalance();
        assertGe(address(footmon).balance, owed, "insolvent: balance < obligations");
    }

    // ── setup / config ───────────────────────────────────────────────────────

    function test_ResolverDefaultsToDeployerThenIsSettable() public {
        FootMon fresh = new FootMon();
        assertEq(fresh.resolver(), address(this));
        fresh.setResolver(resolver);
        assertEq(fresh.resolver(), resolver);
    }

    function test_RevertWhen_NonOwnerSetsResolver() public {
        vm.prank(alice);
        vm.expectRevert("FootMon: not owner");
        footmon.setResolver(alice);
    }

    function test_RevertWhen_ResolverSetToZero() public {
        vm.expectRevert("FootMon: zero address");
        footmon.setResolver(address(0));
    }

    function test_HousePctIsCappedAtFifty() public {
        footmon.setDuelHousePct(50);
        assertEq(footmon.duelHousePct(), 50);

        vm.expectRevert("FootMon: max 50");
        footmon.setDuelHousePct(51);
    }

    function test_DuelExpiryHasMinimum() public {
        vm.expectRevert("FootMon: min 600 seconds");
        footmon.setDuelExpiry(599);

        footmon.setDuelExpiry(600);
        assertEq(footmon.duelExpiry(), 600);
    }

    // ── createDuel ───────────────────────────────────────────────────────────

    function test_CreateDuelEscrowsStake() public {
        vm.prank(alice);
        footmon.createDuel{value: STAKE}(DUEL);

        FootMon.Duel memory duel = footmon.getDuel(DUEL);
        assertEq(duel.creator, alice);
        assertEq(duel.joiner, address(0));
        assertEq(duel.stake, STAKE);
        assertEq(uint8(duel.status), uint8(FootMon.DuelStatus.Open));

        assertEq(address(footmon).balance, STAKE);
        assertEq(footmon.totalEscrowed(), STAKE);
        assertEq(footmon.prizePool(), 0, "stake must not leak into prize pool");
        _assertSolvent();
    }

    function test_RevertWhen_CreateWithZeroStake() public {
        vm.prank(alice);
        vm.expectRevert("FootMon: zero stake");
        footmon.createDuel{value: 0}(DUEL);
    }

    function test_RevertWhen_CreateWithZeroDuelId() public {
        vm.prank(alice);
        vm.expectRevert("FootMon: zero duelId");
        footmon.createDuel{value: STAKE}(bytes32(0));
    }

    function test_RevertWhen_DuelIdReused() public {
        vm.prank(alice);
        footmon.createDuel{value: STAKE}(DUEL);

        vm.prank(bob);
        vm.expectRevert("FootMon: duel exists");
        footmon.createDuel{value: STAKE}(DUEL);
    }

    function test_RevertWhen_CreateWhilePaused() public {
        footmon.setDuelsPaused(true);
        vm.prank(alice);
        vm.expectRevert("FootMon: duels paused");
        footmon.createDuel{value: STAKE}(DUEL);
    }

    // ── joinDuel ─────────────────────────────────────────────────────────────

    function test_JoinDuelFillsPot() public {
        _createAndJoin(DUEL);

        FootMon.Duel memory duel = footmon.getDuel(DUEL);
        assertEq(duel.joiner, bob);
        assertEq(uint8(duel.status), uint8(FootMon.DuelStatus.Full));
        assertEq(address(footmon).balance, STAKE * 2);
        assertEq(footmon.totalEscrowed(), STAKE * 2);
        _assertSolvent();
    }

    function test_RevertWhen_StakeMismatchTooLow() public {
        vm.prank(alice);
        footmon.createDuel{value: STAKE}(DUEL);

        vm.prank(bob);
        vm.expectRevert("FootMon: stake mismatch");
        footmon.joinDuel{value: STAKE - 1}(DUEL);
    }

    function test_RevertWhen_StakeMismatchTooHigh() public {
        vm.prank(alice);
        footmon.createDuel{value: STAKE}(DUEL);

        vm.prank(bob);
        vm.expectRevert("FootMon: stake mismatch");
        footmon.joinDuel{value: STAKE + 1}(DUEL);
    }

    function test_RevertWhen_SelfJoin() public {
        vm.prank(alice);
        footmon.createDuel{value: STAKE}(DUEL);

        vm.prank(alice);
        vm.expectRevert("FootMon: cannot self-join");
        footmon.joinDuel{value: STAKE}(DUEL);
    }

    function test_RevertWhen_DoubleJoin() public {
        _createAndJoin(DUEL);

        vm.prank(carol);
        vm.expectRevert("FootMon: duel not open");
        footmon.joinDuel{value: STAKE}(DUEL);
    }

    function test_RevertWhen_JoinNonexistentDuel() public {
        vm.prank(bob);
        vm.expectRevert("FootMon: duel not open");
        footmon.joinDuel{value: STAKE}(keccak256("nope"));
    }

    function test_RevertWhen_JoinWhilePaused() public {
        vm.prank(alice);
        footmon.createDuel{value: STAKE}(DUEL);

        footmon.setDuelsPaused(true);

        vm.prank(bob);
        vm.expectRevert("FootMon: duels paused");
        footmon.joinDuel{value: STAKE}(DUEL);
    }

    // ── resolveDuel (happy path) ─────────────────────────────────────────────
    //
    // Since v2, resolveDuel PUSHES the prize directly to the winner's wallet
    // rather than crediting pendingClaims. These tests assert on the winner's
    // .balance directly. pendingClaims stays at zero for a normal EOA winner
    // — it's only populated as a fallback when a contract wallet rejects the
    // push (covered by test_PushFallsBackToPendingWhenWinnerRejects).

    function test_ResolveDuelSendsSeventyPercentToWinner() public {
        _createAndJoin(DUEL);

        uint256 pot      = STAKE * 2;
        uint256 houseCut = (pot * 30) / 100;
        uint256 payout   = pot - houseCut;

        uint256 bobBefore = bob.balance;
        vm.prank(resolver);
        footmon.resolveDuel(DUEL, bob);

        assertEq(bob.balance - bobBefore, payout, "winner paid 70% directly");
        assertEq(footmon.pendingClaims(bob), 0, "no pending claim needed");
        assertEq(footmon.pendingClaims(alice), 0, "loser gets nothing");
        assertEq(footmon.houseBalance(), houseCut, "house keeps 30%");
        assertEq(footmon.totalEscrowed(), 0, "escrow released");
        assertEq(uint8(footmon.duelStatus(DUEL)), uint8(FootMon.DuelStatus.Resolved));
        _assertSolvent();
    }

    function test_FullHappyPath_CreateJoinResolve_PushesFundsDirectly() public {
        _createAndJoin(DUEL);

        uint256 payout = (STAKE * 2 * 70) / 100;

        uint256 before = bob.balance;
        vm.prank(resolver);
        footmon.resolveDuel(DUEL, bob);

        // No claim step — funds land in the winner's wallet the moment the
        // resolver's tx confirms.
        assertEq(bob.balance - before, payout, "winner paid out directly");
        assertEq(footmon.pendingClaims(bob), 0);
        assertEq(footmon.totalPendingClaims(), 0);
        assertEq(address(footmon).balance, footmon.houseBalance());
        _assertSolvent();
    }

    function test_ResolveHonoursUpdatedHousePct() public {
        footmon.setDuelHousePct(10);
        _createAndJoin(DUEL);

        uint256 aliceBefore = alice.balance;
        vm.prank(resolver);
        footmon.resolveDuel(DUEL, alice);

        assertEq(alice.balance - aliceBefore, (STAKE * 2 * 90) / 100, "winner paid 90%");
        assertEq(footmon.houseBalance(), (STAKE * 2 * 10) / 100);
        _assertSolvent();
    }

    function test_ResolveWithZeroHousePctPaysFullPot() public {
        footmon.setDuelHousePct(0);
        _createAndJoin(DUEL);

        uint256 aliceBefore = alice.balance;
        vm.prank(resolver);
        footmon.resolveDuel(DUEL, alice);

        assertEq(alice.balance - aliceBefore, STAKE * 2, "winner paid full pot");
        assertEq(footmon.houseBalance(), 0);
        _assertSolvent();
    }

    // ── resolveDuel (authorisation & state) ──────────────────────────────────

    function test_RevertWhen_NonResolverResolves() public {
        _createAndJoin(DUEL);

        vm.prank(alice);
        vm.expectRevert("FootMon: not resolver");
        footmon.resolveDuel(DUEL, alice);
    }

    function test_RevertWhen_OwnerResolvesAfterResolverHandoff() public {
        _createAndJoin(DUEL);

        // Owner is not implicitly the resolver once handed off.
        vm.expectRevert("FootMon: not resolver");
        footmon.resolveDuel(DUEL, alice);
    }

    function test_RevertWhen_DoubleResolve() public {
        _createAndJoin(DUEL);

        vm.prank(resolver);
        footmon.resolveDuel(DUEL, bob);

        vm.prank(resolver);
        vm.expectRevert("FootMon: duel not resolvable");
        footmon.resolveDuel(DUEL, bob);
    }

    function test_RevertWhen_ResolveUnfilledDuel() public {
        vm.prank(alice);
        footmon.createDuel{value: STAKE}(DUEL);

        vm.prank(resolver);
        vm.expectRevert("FootMon: duel not resolvable");
        footmon.resolveDuel(DUEL, alice);
    }

    function test_RevertWhen_WinnerIsNotAParticipant() public {
        _createAndJoin(DUEL);

        vm.prank(resolver);
        vm.expectRevert("FootMon: winner not a participant");
        footmon.resolveDuel(DUEL, carol);
    }

    function test_RevertWhen_WinnerIsZeroAddress() public {
        _createAndJoin(DUEL);

        vm.prank(resolver);
        vm.expectRevert("FootMon: winner not a participant");
        footmon.resolveDuel(DUEL, address(0));
    }

    // ── draws ────────────────────────────────────────────────────────────────

    function test_DrawRefundsBothStakesWithNoRake() public {
        _createAndJoin(DUEL);

        uint256 aliceBefore = alice.balance;
        uint256 bobBefore   = bob.balance;

        vm.prank(resolver);
        footmon.resolveDuelDraw(DUEL);

        // Push refunds land in both wallets — no pending claim step.
        assertEq(alice.balance - aliceBefore, STAKE, "alice refunded");
        assertEq(bob.balance - bobBefore, STAKE, "bob refunded");
        assertEq(footmon.pendingClaims(alice), 0);
        assertEq(footmon.pendingClaims(bob), 0);
        assertEq(footmon.houseBalance(), 0, "no rake on a draw");
        assertEq(footmon.totalEscrowed(), 0);
        _assertSolvent();
    }

    function test_RevertWhen_NonResolverDeclaresDraw() public {
        _createAndJoin(DUEL);
        vm.prank(alice);
        vm.expectRevert("FootMon: not resolver");
        footmon.resolveDuelDraw(DUEL);
    }

    // ── cancel ───────────────────────────────────────────────────────────────

    function test_CancelDuelRefundsCreator() public {
        vm.prank(alice);
        footmon.createDuel{value: STAKE}(DUEL);

        uint256 before = alice.balance;
        vm.prank(alice);
        footmon.cancelDuel(DUEL);

        assertEq(alice.balance - before, STAKE, "stake returned");
        assertEq(footmon.totalEscrowed(), 0);
        assertEq(address(footmon).balance, 0);
        assertEq(uint8(footmon.duelStatus(DUEL)), uint8(FootMon.DuelStatus.Cancelled));
        _assertSolvent();
    }

    function test_RevertWhen_NonCreatorCancels() public {
        vm.prank(alice);
        footmon.createDuel{value: STAKE}(DUEL);

        vm.prank(bob);
        vm.expectRevert("FootMon: not creator");
        footmon.cancelDuel(DUEL);
    }

    function test_RevertWhen_CancelAfterJoin() public {
        _createAndJoin(DUEL);

        vm.prank(alice);
        vm.expectRevert("FootMon: duel not open");
        footmon.cancelDuel(DUEL);
    }

    function test_RevertWhen_CancelTwice() public {
        vm.prank(alice);
        footmon.createDuel{value: STAKE}(DUEL);
        vm.prank(alice);
        footmon.cancelDuel(DUEL);

        vm.prank(alice);
        vm.expectRevert("FootMon: duel not open");
        footmon.cancelDuel(DUEL);
    }

    // ── timeout refund ───────────────────────────────────────────────────────

    function test_RefundExpiredOpenDuelReturnsCreatorStake() public {
        vm.prank(alice);
        footmon.createDuel{value: STAKE}(DUEL);

        vm.warp(block.timestamp + footmon.duelExpiry());
        footmon.refundExpiredDuel(DUEL); // permissionless

        assertEq(footmon.pendingClaims(alice), STAKE);
        assertEq(footmon.totalEscrowed(), 0);
        assertEq(uint8(footmon.duelStatus(DUEL)), uint8(FootMon.DuelStatus.Refunded));
        _assertSolvent();
    }

    function test_RefundExpiredFullDuelReturnsBothStakes() public {
        _createAndJoin(DUEL);

        vm.warp(block.timestamp + footmon.duelExpiry() + 1);
        vm.prank(carol); // any third party can unstick it
        footmon.refundExpiredDuel(DUEL);

        assertEq(footmon.pendingClaims(alice), STAKE);
        assertEq(footmon.pendingClaims(bob), STAKE);
        assertEq(footmon.totalEscrowed(), 0);
        assertEq(footmon.houseBalance(), 0, "no rake on a refund");
        _assertSolvent();

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        footmon.claimDuelPrize();
        assertEq(alice.balance - aliceBefore, STAKE);
    }

    function test_RevertWhen_RefundBeforeExpiry() public {
        _createAndJoin(DUEL);

        vm.warp(block.timestamp + footmon.duelExpiry() - 1);
        vm.expectRevert("FootMon: not expired");
        footmon.refundExpiredDuel(DUEL);
    }

    function test_RevertWhen_RefundAlreadyResolvedDuel() public {
        _createAndJoin(DUEL);
        vm.prank(resolver);
        footmon.resolveDuel(DUEL, bob);

        vm.warp(block.timestamp + footmon.duelExpiry() + 1);
        vm.expectRevert("FootMon: duel not active");
        footmon.refundExpiredDuel(DUEL);
    }

    function test_RevertWhen_ResolveAfterTimeoutRefund() public {
        _createAndJoin(DUEL);
        vm.warp(block.timestamp + footmon.duelExpiry() + 1);
        footmon.refundExpiredDuel(DUEL);

        vm.prank(resolver);
        vm.expectRevert("FootMon: duel not resolvable");
        footmon.resolveDuel(DUEL, bob);
    }

    function test_TimeUntilDuelExpiryCountsDown() public {
        vm.prank(alice);
        footmon.createDuel{value: STAKE}(DUEL);

        assertEq(footmon.timeUntilDuelExpiry(DUEL), footmon.duelExpiry());
        vm.warp(block.timestamp + 600);
        assertEq(footmon.timeUntilDuelExpiry(DUEL), footmon.duelExpiry() - 600);
        vm.warp(block.timestamp + footmon.duelExpiry());
        assertEq(footmon.timeUntilDuelExpiry(DUEL), 0);
    }

    // ── owner emergency refund ───────────────────────────────────────────────

    function test_OwnerRefundDuelReturnsBothStakes() public {
        _createAndJoin(DUEL);

        footmon.ownerRefundDuel(DUEL); // no need to wait for expiry

        assertEq(footmon.pendingClaims(alice), STAKE);
        assertEq(footmon.pendingClaims(bob), STAKE);
        assertEq(footmon.totalEscrowed(), 0);
        _assertSolvent();
    }

    function test_RevertWhen_NonOwnerEmergencyRefunds() public {
        _createAndJoin(DUEL);
        vm.prank(alice);
        vm.expectRevert("FootMon: not owner");
        footmon.ownerRefundDuel(DUEL);
    }

    // ── claim semantics ──────────────────────────────────────────────────────
    //
    // With push-payment, winners get their MON at resolveDuel time, so an
    // EOA winner has nothing to claim afterwards. The claimDuelPrize path
    // stays alive purely as a safety net for contract wallets that refused
    // the push; these tests confirm the two paths interact correctly.

    function test_RevertWhen_WinnerTriesToClaimAfterPush() public {
        _createAndJoin(DUEL);
        vm.prank(resolver);
        footmon.resolveDuel(DUEL, bob);

        // Push already delivered — pendingClaims is empty for the winner.
        vm.prank(bob);
        vm.expectRevert("FootMon: nothing to claim");
        footmon.claimDuelPrize();
    }

    function test_RevertWhen_LoserClaims() public {
        _createAndJoin(DUEL);
        vm.prank(resolver);
        footmon.resolveDuel(DUEL, bob);

        vm.prank(alice);
        vm.expectRevert("FootMon: nothing to claim");
        footmon.claimDuelPrize();
    }

    // ── reentrancy ───────────────────────────────────────────────────────────

    function test_PushFallsBackToPendingWhenWinnerRejects() public {
        // A contract wallet that reverts on receive() should NOT strand the
        // resolver — the push fails silently and the funds land in
        // pendingClaims for a later manual claim.
        RevertingReceiver hostile = new RevertingReceiver(footmon);
        vm.deal(address(hostile), STAKE);

        // Hostile creates the duel, bob joins as the counterparty.
        hostile.createDuel(DUEL, STAKE);
        vm.prank(bob);
        footmon.joinDuel{value: STAKE}(DUEL);

        uint256 payout = (STAKE * 2 * 70) / 100;
        vm.prank(resolver);
        footmon.resolveDuel(DUEL, address(hostile));

        // Direct push failed (hostile reverts on receive) → fallback ledger.
        assertEq(address(hostile).balance, 0, "push rejected, no direct delivery");
        assertEq(footmon.pendingClaims(address(hostile)), payout, "credited as pending");
        assertEq(uint8(footmon.duelStatus(DUEL)), uint8(FootMon.DuelStatus.Resolved));
        _assertSolvent();
    }

    function test_ReentrantResolveIsBlockedByNonReentrantGuard() public {
        // A malicious winner cannot re-enter resolveDuel or claimDuelPrize
        // from inside receive() during the push — both are guarded by the
        // shared nonReentrant modifier. Depending on gas dynamics the outer
        // push either succeeds cleanly OR falls back to pendingClaims; the
        // guarantee we care about is that the reentry itself never
        // succeeds and the attacker is paid exactly once in total.
        ReentrantClaimer attacker = new ReentrantClaimer(footmon);
        vm.deal(address(attacker), STAKE);

        vm.prank(alice);
        footmon.createDuel{value: STAKE}(DUEL);
        attacker.joinDuel(DUEL, STAKE);

        uint256 payout = (STAKE * 2 * 70) / 100;
        vm.prank(resolver);
        footmon.resolveDuel(DUEL, address(attacker));

        assertFalse(attacker.reenteredSuccessfully(), "re-entry must never succeed");

        // Either the push made it in one hop, or it fell back to pending
        // and needs a manual claim. Both paths must total exactly `payout`.
        uint256 pending = footmon.pendingClaims(address(attacker));
        if (pending > 0) {
            assertEq(pending, payout, "pending equals payout");
            attacker.setAttack(false); // don't re-enter on the successful pull
            attacker.claim();
        }
        assertEq(address(attacker).balance, payout, "attacker paid exactly once total");
        assertEq(footmon.pendingClaims(address(attacker)), 0);
        _assertSolvent();
    }

    function test_ReentrantCancelCannotDoubleRefund() public {
        ReentrantClaimer attacker = new ReentrantClaimer(footmon);
        vm.deal(address(attacker), STAKE * 2);

        // Attacker creates, then cancels and re-enters from receive().
        vm.prank(address(attacker));
        footmon.createDuel{value: STAKE}(DUEL);

        vm.prank(address(attacker));
        footmon.cancelDuel(DUEL);

        assertEq(address(footmon).balance, 0, "no double refund");
        assertEq(footmon.totalEscrowed(), 0);
        _assertSolvent();
    }

    function test_RefundIsPullSoHostileReceiverCannotGriefTimeout() public {
        RevertingReceiver hostile = new RevertingReceiver(footmon);
        vm.deal(address(hostile), STAKE);

        hostile.createDuel(DUEL, STAKE);

        vm.prank(bob);
        footmon.joinDuel{value: STAKE}(DUEL);

        vm.warp(block.timestamp + footmon.duelExpiry() + 1);

        // Succeeds even though the creator rejects MON: refunds are credited,
        // not pushed, so bob is never trapped by a hostile opponent.
        footmon.refundExpiredDuel(DUEL);

        assertEq(footmon.pendingClaims(bob), STAKE);
        uint256 before = bob.balance;
        vm.prank(bob);
        footmon.claimDuelPrize();
        assertEq(bob.balance - before, STAKE);
        _assertSolvent();
    }

    function test_CancelRevertsWhenCreatorRejectsRefund() public {
        RevertingReceiver hostile = new RevertingReceiver(footmon);
        vm.deal(address(hostile), STAKE);
        hostile.createDuel(DUEL, STAKE);

        vm.expectRevert("FootMon: refund failed");
        hostile.cancelDuel(DUEL);
    }

    // ── fund isolation ───────────────────────────────────────────────────────

    function test_EmergencyWithdrawCannotTouchEscrowedStakes() public {
        _createAndJoin(DUEL);

        assertEq(footmon.freeBalance(), 0, "escrow is not free balance");
        vm.expectRevert("FootMon: nothing free to withdraw");
        footmon.emergencyWithdraw();

        assertEq(address(footmon).balance, STAKE * 2, "stakes untouched");
        _assertSolvent();
    }

    function test_EmergencyWithdrawCannotTouchDuelFunds() public {
        _createAndJoin(DUEL);
        vm.prank(resolver);
        footmon.resolveDuel(DUEL, bob);

        // The 70% went straight to bob; the remaining 30% sits as house
        // rake and is untouchable by emergencyWithdraw.
        assertEq(footmon.freeBalance(), 0);
        vm.expectRevert("FootMon: nothing free to withdraw");
        footmon.emergencyWithdraw();

        _assertSolvent();
    }

    function test_EmergencyWithdrawSweepsOnlyUnencumberedBalance() public {
        _createAndJoin(DUEL);

        // Stray MON forced in without going through receive().
        vm.deal(address(footmon), address(footmon).balance + 3 ether);
        assertEq(footmon.freeBalance(), 3 ether);

        uint256 before = owner.balance;
        footmon.emergencyWithdraw();

        assertEq(owner.balance - before, 3 ether);
        assertEq(address(footmon).balance, STAKE * 2, "escrow preserved");
        _assertSolvent();
    }

    function test_RollRevenueAndDuelEscrowStaySeparate() public {
        vm.prank(alice);
        footmon.payForRoll{value: 0.01 ether}(); // matches the default rollPrice
        uint256 poolAfterRoll = footmon.prizePool();
        assertGt(poolAfterRoll, 0);

        _createAndJoin(DUEL);

        assertEq(footmon.prizePool(), poolAfterRoll, "duel stakes never enter prize pool");
        assertEq(footmon.totalEscrowed(), STAKE * 2);
        _assertSolvent();
    }

    function test_WithdrawHouseTransfersRakeOnly() public {
        _createAndJoin(DUEL);
        vm.prank(resolver);
        footmon.resolveDuel(DUEL, bob);

        uint256 houseCut = (STAKE * 2 * 30) / 100;
        uint256 before = owner.balance;

        footmon.withdrawHouse();

        assertEq(owner.balance - before, houseCut);
        assertEq(footmon.houseBalance(), 0);
        // Winner already got their share directly; contract now empty
        // aside from any leftover unclaimed prize-pool balance.
        assertEq(address(footmon).balance, 0);
        _assertSolvent();
    }

    function test_RevertWhen_WithdrawHouseWithNothingAccrued() public {
        vm.expectRevert("FootMon: no house balance");
        footmon.withdrawHouse();
    }

    function test_RevertWhen_NonOwnerWithdrawsHouse() public {
        _createAndJoin(DUEL);
        vm.prank(resolver);
        footmon.resolveDuel(DUEL, bob);

        vm.prank(alice);
        vm.expectRevert("FootMon: not owner");
        footmon.withdrawHouse();
    }

    // ── concurrency ──────────────────────────────────────────────────────────

    function test_ConcurrentDuelsAreIndependent() public {
        bytes32 duelA = keccak256("A");
        bytes32 duelB = keccak256("B");

        vm.prank(alice);
        footmon.createDuel{value: 1 ether}(duelA);
        vm.prank(bob);
        footmon.joinDuel{value: 1 ether}(duelA);

        vm.prank(carol);
        footmon.createDuel{value: 5 ether}(duelB);

        assertEq(footmon.totalEscrowed(), 7 ether);

        vm.prank(resolver);
        footmon.resolveDuel(duelA, alice);

        // duelB is untouched and still cancellable.
        assertEq(uint8(footmon.duelStatus(duelB)), uint8(FootMon.DuelStatus.Open));
        assertEq(footmon.totalEscrowed(), 5 ether);

        vm.prank(carol);
        footmon.cancelDuel(duelB);
        assertEq(footmon.totalEscrowed(), 0);
        _assertSolvent();
    }

    function test_PauseDoesNotBlockResolvingInFlightDuels() public {
        _createAndJoin(DUEL);
        footmon.setDuelsPaused(true);

        uint256 before = bob.balance;
        vm.prank(resolver);
        footmon.resolveDuel(DUEL, bob);

        // Pause blocks NEW duels but a resolvable in-flight one still
        // pays out directly to the winner.
        assertEq(bob.balance - before, (STAKE * 2 * 70) / 100);
        assertEq(footmon.pendingClaims(bob), 0);
        _assertSolvent();
    }

    // ── fuzz ─────────────────────────────────────────────────────────────────

    function testFuzz_ResolveSplitIsExactAndSolvent(uint96 stake, uint8 pctRaw) public {
        uint256 amount = uint256(stake);
        vm.assume(amount > 0);
        uint256 pct = uint256(pctRaw) % 51; // contract caps at 50

        footmon.setDuelHousePct(pct);

        vm.deal(alice, amount);
        vm.deal(bob, amount);

        vm.prank(alice);
        footmon.createDuel{value: amount}(DUEL);
        vm.prank(bob);
        footmon.joinDuel{value: amount}(DUEL);

        uint256 aliceBefore = alice.balance;
        vm.prank(resolver);
        footmon.resolveDuel(DUEL, alice);

        uint256 pot = amount * 2;
        uint256 houseCut = (pot * pct) / 100;
        uint256 payout   = pot - houseCut;

        // Direct push + house rake must account for the entire pot,
        // regardless of the split percentage.
        assertEq(alice.balance - aliceBefore, payout, "winner paid net-of-rake");
        assertEq(footmon.houseBalance(), houseCut);
        assertEq(footmon.totalEscrowed(), 0);
        _assertSolvent();
    }

    function testFuzz_StakeMustMatchExactly(uint96 stake, uint96 wrong) public {
        uint256 amount = uint256(stake);
        vm.assume(amount > 0);
        vm.assume(wrong != stake);

        vm.deal(alice, amount);
        vm.prank(alice);
        footmon.createDuel{value: amount}(DUEL);

        vm.deal(bob, uint256(wrong));
        vm.prank(bob);
        vm.expectRevert("FootMon: stake mismatch");
        footmon.joinDuel{value: uint256(wrong)}(DUEL);
    }

    receive() external payable {}
}
