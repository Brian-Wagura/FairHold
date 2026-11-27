// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MediatedEscrow} from "../src/MediatedEscrow.sol";
import {MediatorRegistry} from "../src/MediatorRegistry.sol";
import {MockUSD8, FeeToken} from "./mocks/MockUSD8.sol";

contract MediatedEscrowTest is Test {
    MediatedEscrow internal escrow;
    MockUSD8 internal usd;

    uint256 internal payerPk = 0xA11CE;
    address internal payer;
    address internal payee = makeAddr("payee");
    address internal mediator = makeAddr("mediator");
    address internal sessionKey = makeAddr("sessionKey");
    address internal stranger = makeAddr("stranger");

    uint128 internal constant AMOUNT = 1_000e6; // 1,000 tUSD8
    uint64 internal constant ACTIVE = 7 days;
    uint64 internal constant EVIDENCE = 2 days;
    uint64 internal constant PROPOSE = 1 days;
    uint64 internal constant RESPONSE = 1 days;

    function setUp() public {
        vm.warp(1_700_000_000);
        payer = vm.addr(payerPk);
        usd = new MockUSD8();
        escrow = new MediatedEscrow(IERC20(address(usd)));

        vm.prank(mediator);
        escrow.registerMediator("ipfs://fairhold-mediator");
        vm.prank(mediator);
        escrow.setSessionKey(sessionKey, uint64(vm.getBlockTimestamp() + 7 days), 10);

        usd.mint(payer, 10_000e6);
        vm.prank(payer);
        usd.approve(address(escrow), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _terms() internal view returns (MediatedEscrow.Terms memory t) {
        t = MediatedEscrow.Terms({
            payee: payee,
            mediator: mediator,
            amount: AMOUNT,
            acceptBy: uint64(vm.getBlockTimestamp() + 1 days),
            activeDuration: ACTIVE,
            evidenceWindow: EVIDENCE,
            proposeWindow: PROPOSE,
            responseWindow: RESPONSE,
            undisputedPayeeBps: 10_000,
            disputeFallbackPayeeBps: 5_000,
            termsHash: keccak256("Logo design, 3 revisions, delivered as SVG")
        });
    }

    function _create() internal returns (uint256 id) {
        vm.prank(payer);
        id = escrow.createEscrow(_terms());
    }

    function _active() internal returns (uint256 id) {
        id = _create();
        bytes32 digest = escrow.termsDigest(id);
        vm.prank(payee);
        escrow.acceptTerms(id, digest);
    }

    function _disputed() internal returns (uint256 id) {
        id = _active();
        vm.prank(payee);
        escrow.openDispute(id);
    }

    function _proposed(uint128 payeeAmount) internal returns (uint256 id) {
        id = _disputed();
        vm.warp(vm.getBlockTimestamp() + EVIDENCE);
        vm.prank(sessionKey);
        escrow.propose(id, payeeAmount, keccak256("reasoning"));
    }

    function _status(uint256 id) internal view returns (MediatedEscrow.Status) {
        return escrow.getEscrow(id).status;
    }

    function _assertSettled(uint256 id, MediatedEscrow.Resolution r, uint256 payeeAmt) internal view {
        MediatedEscrow.Escrow memory e = escrow.getEscrow(id);
        assertEq(uint8(e.resolution), uint8(r), "resolution");
        assertEq(e.payeePaid, payeeAmt, "payeePaid");
        assertEq(e.payeePaid + e.payerPaid, AMOUNT, "sum");
        assertEq(usd.balanceOf(payee), payeeAmt, "payee balance");
        assertEq(usd.balanceOf(address(escrow)), 0, "escrow drained");
    }

    // ------------------------------------------------------------------ creation

    function test_create_storesTermsAndPullsFunds() public {
        uint256 id = _create();
        MediatedEscrow.Escrow memory e = escrow.getEscrow(id);
        assertEq(id, 1);
        assertEq(e.payer, payer);
        assertEq(e.payee, payee);
        assertEq(e.mediator, mediator);
        assertEq(e.amount, AMOUNT);
        assertEq(uint8(e.status), uint8(MediatedEscrow.Status.AwaitingPayee));
        assertEq(usd.balanceOf(address(escrow)), AMOUNT);
        assertEq(escrow.escrowsOf(payer)[0], id);
        assertEq(escrow.escrowsOf(payee)[0], id);
        assertEq(escrow.escrowsOf(mediator)[0], id);
    }

    function test_createWithPermit_singleTx() public {
        vm.prank(payer);
        usd.approve(address(escrow), 0);
        MediatedEscrow.Terms memory t = _terms();
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 structHash =
            keccak256(abi.encode(usd.PERMIT_TYPEHASH(), payer, address(escrow), t.amount, usd.nonces(payer), deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(payerPk, keccak256(abi.encodePacked("\x19\x01", usd.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(payer);
        uint256 id = escrow.createEscrowWithPermit(t, deadline, v, r, s);
        assertEq(usd.balanceOf(address(escrow)), AMOUNT);
        assertEq(id, 1);
    }

    function test_createWithPermit_frontRunPermitStillWorks() public {
        // Allowance already exists (e.g. the permit was front-run); invalid sig is tolerated.
        vm.prank(payer);
        escrow.createEscrowWithPermit(_terms(), vm.getBlockTimestamp(), 0, bytes32(0), bytes32(0));
        assertEq(usd.balanceOf(address(escrow)), AMOUNT);
    }

    function test_create_revertsOnInvalidTerms() public {
        MediatedEscrow.Terms memory t;

        t = _terms();
        t.payee = address(0);
        _expectInvalid(t, "payee is zero");

        t = _terms();
        t.payee = payer;
        _expectInvalid(t, "payee is payer");

        t = _terms();
        t.mediator = payee;
        _expectInvalid(t, "mediator is a party");

        t = _terms();
        t.mediator = stranger;
        _expectInvalid(t, "mediator not active");

        t = _terms();
        t.amount = 0;
        _expectInvalid(t, "amount is zero");

        t = _terms();
        t.acceptBy = uint64(vm.getBlockTimestamp());
        _expectInvalid(t, "acceptBy in past");

        t = _terms();
        t.evidenceWindow = 10;
        _expectInvalid(t, "window out of range");

        t = _terms();
        t.disputeFallbackPayeeBps = 10_001;
        _expectInvalid(t, "bps > 10000");
    }

    function _expectInvalid(MediatedEscrow.Terms memory t, string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(MediatedEscrow.InvalidTerms.selector, reason));
        vm.prank(payer);
        escrow.createEscrow(t);
    }

    function test_create_pausedMediatorRejected() public {
        vm.prank(mediator);
        escrow.updateMediator(false, "paused");
        vm.expectRevert(abi.encodeWithSelector(MediatedEscrow.InvalidTerms.selector, "mediator not active"));
        vm.prank(payer);
        escrow.createEscrow(_terms());
    }

    function test_create_rejectsFeeOnTransferToken() public {
        FeeToken fee = new FeeToken();
        MediatedEscrow e2 = new MediatedEscrow(IERC20(address(fee)));
        vm.prank(mediator);
        e2.registerMediator("m");
        fee.mint(payer, AMOUNT);
        vm.startPrank(payer);
        fee.approve(address(e2), AMOUNT);
        vm.expectRevert(MediatedEscrow.UnsupportedToken.selector);
        e2.createEscrow(_terms());
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ acceptance / cancel

    function test_accept_setsActiveDeadline() public {
        uint256 id = _active();
        MediatedEscrow.Escrow memory e = escrow.getEscrow(id);
        assertEq(uint8(e.status), uint8(MediatedEscrow.Status.Active));
        assertEq(e.activeDeadline, vm.getBlockTimestamp() + ACTIVE);
    }

    function test_accept_onlyPayee() public {
        uint256 id = _create();
        bytes32 d = escrow.termsDigest(id);
        vm.expectRevert(MediatedEscrow.NotPayee.selector);
        vm.prank(stranger);
        escrow.acceptTerms(id, d);
    }

    function test_accept_wrongDigestReverts() public {
        uint256 id = _create();
        vm.expectRevert(MediatedEscrow.TermsMismatch.selector);
        vm.prank(payee);
        escrow.acceptTerms(id, keccak256("other terms"));
    }

    function test_accept_atDeadlineReverts() public {
        uint256 id = _create();
        bytes32 d = escrow.termsDigest(id);
        vm.warp(escrow.getEscrow(id).acceptBy);
        vm.expectRevert(abi.encodeWithSelector(MediatedEscrow.DeadlinePassed.selector, escrow.getEscrow(id).acceptBy));
        vm.prank(payee);
        escrow.acceptTerms(id, d);
    }

    function test_accept_justBeforeDeadline() public {
        uint256 id = _create();
        bytes32 d = escrow.termsDigest(id);
        vm.warp(escrow.getEscrow(id).acceptBy - 1);
        vm.prank(payee);
        escrow.acceptTerms(id, d);
        assertEq(uint8(_status(id)), uint8(MediatedEscrow.Status.Active));
    }

    function test_digestIsBoundToEscrowId() public {
        uint256 a = _create();
        uint256 b = _create();
        assertTrue(escrow.termsDigest(a) != escrow.termsDigest(b));
        bytes32 da = escrow.termsDigest(a);
        vm.expectRevert(MediatedEscrow.TermsMismatch.selector);
        vm.prank(payee);
        escrow.acceptTerms(b, da);
    }

    function test_cancel_refundsPayer() public {
        uint256 id = _create();
        uint256 before = usd.balanceOf(payer);
        vm.prank(payer);
        escrow.cancel(id);
        assertEq(usd.balanceOf(payer), before + AMOUNT);
        assertEq(uint8(_status(id)), uint8(MediatedEscrow.Status.Cancelled));
        assertEq(uint8(escrow.getEscrow(id).resolution), uint8(MediatedEscrow.Resolution.Cancelled));
    }

    function test_cancel_onlyPayerAndOnlyBeforeAcceptance() public {
        uint256 id = _create();
        vm.expectRevert(MediatedEscrow.NotPayer.selector);
        vm.prank(payee);
        escrow.cancel(id);

        bytes32 d = escrow.termsDigest(id);
        vm.prank(payee);
        escrow.acceptTerms(id, d);
        vm.expectRevert(abi.encodeWithSelector(MediatedEscrow.WrongStatus.selector, MediatedEscrow.Status.Active));
        vm.prank(payer);
        escrow.cancel(id);
    }

    function test_finalize_expiredAcceptanceRefundsPayer() public {
        uint256 id = _create();
        vm.warp(escrow.getEscrow(id).acceptBy);
        uint256 before = usd.balanceOf(payer);
        vm.prank(stranger);
        escrow.finalize(id);
        assertEq(usd.balanceOf(payer), before + AMOUNT);
        assertEq(uint8(escrow.getEscrow(id).resolution), uint8(MediatedEscrow.Resolution.Expired));
    }

    // ------------------------------------------------------------------ mutual settlement

    function test_mutual_matchingOffersSettle() public {
        uint256 id = _active();
        vm.prank(payer);
        escrow.offerSettlement(id, 700e6);
        assertEq(uint8(_status(id)), uint8(MediatedEscrow.Status.Active));
        vm.prank(payee);
        escrow.offerSettlement(id, 700e6);
        _assertSettled(id, MediatedEscrow.Resolution.Mutual, 700e6);
    }

    function test_mutual_mismatchDoesNotSettle_thenUpdateMatches() public {
        uint256 id = _active();
        vm.prank(payer);
        escrow.offerSettlement(id, 600e6);
        vm.prank(payee);
        escrow.offerSettlement(id, 800e6);
        assertEq(uint8(_status(id)), uint8(MediatedEscrow.Status.Active));
        vm.prank(payer);
        escrow.offerSettlement(id, 800e6);
        _assertSettled(id, MediatedEscrow.Resolution.Mutual, 800e6);
    }

    function test_mutual_zeroAndFullAreValid() public {
        uint256 id = _active();
        vm.prank(payer);
        escrow.offerSettlement(id, 0);
        vm.prank(payee);
        escrow.offerSettlement(id, 0);
        _assertSettled(id, MediatedEscrow.Resolution.Mutual, 0);
    }

    function test_mutual_offerAboveAmountReverts() public {
        uint256 id = _active();
        vm.expectRevert(abi.encodeWithSelector(MediatedEscrow.AmountExceedsEscrow.selector, AMOUNT + 1, AMOUNT));
        vm.prank(payer);
        escrow.offerSettlement(id, AMOUNT + 1);
    }

    function test_mutual_strangerCannotOffer() public {
        uint256 id = _active();
        vm.expectRevert(MediatedEscrow.NotParty.selector);
        vm.prank(stranger);
        escrow.offerSettlement(id, 1);
    }

    function test_mutual_withdrawnOfferDoesNotMatch() public {
        uint256 id = _active();
        vm.prank(payer);
        escrow.offerSettlement(id, 500e6);
        vm.prank(payer);
        escrow.withdrawOffer(id);
        vm.prank(payee);
        escrow.offerSettlement(id, 500e6);
        assertEq(uint8(_status(id)), uint8(MediatedEscrow.Status.Active));
    }

    function test_mutual_staleOfferClearedByDispute() public {
        uint256 id = _active();
        vm.prank(payer);
        escrow.offerSettlement(id, 500e6);
        vm.prank(payee);
        escrow.openDispute(id);
        // Payee matching the pre-dispute offer must not settle: offers were reset.
        vm.prank(payee);
        escrow.offerSettlement(id, 500e6);
        assertEq(uint8(_status(id)), uint8(MediatedEscrow.Status.Disputed));
    }

    function test_mutual_availableDuringProposal() public {
        uint256 id = _proposed(900e6);
        vm.prank(payer);
        escrow.offerSettlement(id, 750e6);
        vm.prank(payee);
        escrow.offerSettlement(id, 750e6);
        _assertSettled(id, MediatedEscrow.Resolution.Mutual, 750e6);
    }

    function test_mutual_notBeforeAcceptance() public {
        uint256 id = _create();
        vm.expectRevert(
            abi.encodeWithSelector(MediatedEscrow.WrongStatus.selector, MediatedEscrow.Status.AwaitingPayee)
        );
        vm.prank(payer);
        escrow.offerSettlement(id, 1);
    }

    // ------------------------------------------------------------------ undisputed fallback

    function test_undisputed_finalizesAtDeadline() public {
        uint256 id = _active();
        uint64 deadline = escrow.getEscrow(id).activeDeadline;
        vm.warp(deadline - 1);
        vm.expectRevert(MediatedEscrow.NothingToFinalize.selector);
        escrow.finalize(id);

        vm.warp(deadline);
        (bool ready, MediatedEscrow.Resolution r, uint128 amt) = escrow.previewFinalize(id);
        assertTrue(ready);
        assertEq(uint8(r), uint8(MediatedEscrow.Resolution.Undisputed));
        assertEq(amt, AMOUNT);
        vm.prank(stranger);
        escrow.finalize(id);
        _assertSettled(id, MediatedEscrow.Resolution.Undisputed, AMOUNT);
    }

    function test_undisputed_cannotDisputeAfterDeadline() public {
        uint256 id = _active();
        uint64 deadline = escrow.getEscrow(id).activeDeadline;
        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(MediatedEscrow.DeadlinePassed.selector, deadline));
        vm.prank(payer);
        escrow.openDispute(id);
    }

    // ------------------------------------------------------------------ dispute / evidence

    function test_dispute_setsDeadlinesAndRecordsOpener() public {
        uint256 id = _active();
        vm.prank(payer);
        escrow.openDispute(id);
        MediatedEscrow.Escrow memory e = escrow.getEscrow(id);
        assertEq(uint8(e.status), uint8(MediatedEscrow.Status.Disputed));
        assertEq(e.disputedBy, payer);
        assertEq(e.evidenceDeadline, vm.getBlockTimestamp() + EVIDENCE);
        assertEq(e.proposeDeadline, vm.getBlockTimestamp() + EVIDENCE + PROPOSE);
    }

    function test_dispute_onlyParties() public {
        uint256 id = _active();
        vm.expectRevert(MediatedEscrow.NotParty.selector);
        vm.prank(mediator);
        escrow.openDispute(id);
    }

    function test_dispute_cannotDisputeTwice() public {
        uint256 id = _disputed();
        vm.expectRevert(abi.encodeWithSelector(MediatedEscrow.WrongStatus.selector, MediatedEscrow.Status.Disputed));
        vm.prank(payer);
        escrow.openDispute(id);
    }

    function test_evidence_windowBoundaries() public {
        uint256 id = _active();
        // Evidence is allowed while active (e.g. proof of delivery).
        vm.prank(payee);
        escrow.submitEvidence(id, keccak256("delivery.zip"), "fairhold://evidence/1");
        vm.prank(payer);
        escrow.openDispute(id);
        uint64 deadline = escrow.getEscrow(id).evidenceDeadline;

        vm.warp(deadline - 1);
        vm.prank(payer);
        escrow.submitEvidence(id, keccak256("complaint.pdf"), "");

        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(MediatedEscrow.DeadlinePassed.selector, deadline));
        vm.prank(payer);
        escrow.submitEvidence(id, keccak256("late.pdf"), "");

        MediatedEscrow.Evidence[] memory ev = escrow.getEvidence(id);
        assertEq(ev.length, 2);
        assertEq(ev[0].submitter, payee);
        assertEq(ev[0].contentHash, keccak256("delivery.zip"));
        assertEq(ev[1].submitter, payer);
    }

    function test_evidence_rejectsEmptyHashStrangersAndCap() public {
        uint256 id = _disputed();
        vm.expectRevert(MediatedEscrow.EmptyHash.selector);
        vm.prank(payer);
        escrow.submitEvidence(id, bytes32(0), "");

        vm.expectRevert(MediatedEscrow.NotParty.selector);
        vm.prank(stranger);
        escrow.submitEvidence(id, keccak256("x"), "");

        uint256 perParty = escrow.MAX_EVIDENCE_PER_PARTY();
        for (uint256 i = 0; i < perParty; i++) {
            vm.prank(payer);
            escrow.submitEvidence(id, keccak256(abi.encode("payer", i)), "");
        }
        // The payer has used its share and is capped...
        vm.expectRevert(MediatedEscrow.EvidenceLimitReached.selector);
        vm.prank(payer);
        escrow.submitEvidence(id, keccak256("payer overflow"), "");

        // ...but the payee's reserved share is untouched.
        for (uint256 i = 0; i < perParty; i++) {
            vm.prank(payee);
            escrow.submitEvidence(id, keccak256(abi.encode("payee", i)), "");
        }
        assertEq(escrow.getEvidence(id).length, escrow.MAX_EVIDENCE());
        vm.expectRevert(MediatedEscrow.EvidenceLimitReached.selector);
        vm.prank(payee);
        escrow.submitEvidence(id, keccak256("overflow"), "");
    }

    function test_evidence_partyCannotExhaustOtherPartysShareBeforeDispute() public {
        uint256 id = _active();
        // Payer floods evidence while Active, before any dispute exists.
        for (uint256 i = 0; i < escrow.MAX_EVIDENCE_PER_PARTY(); i++) {
            vm.prank(payer);
            escrow.submitEvidence(id, keccak256(abi.encode(i)), "");
        }
        vm.prank(payer);
        escrow.openDispute(id);
        // The payee can still respond within the evidence window.
        vm.prank(payee);
        escrow.submitEvidence(id, keccak256("payee rebuttal"), "");
        MediatedEscrow.Evidence[] memory ev = escrow.getEvidence(id);
        assertEq(ev[ev.length - 1].submitter, payee);
    }

    function test_evidence_notAllowedBeforeAcceptance() public {
        uint256 id = _create();
        vm.expectRevert(
            abi.encodeWithSelector(MediatedEscrow.WrongStatus.selector, MediatedEscrow.Status.AwaitingPayee)
        );
        vm.prank(payer);
        escrow.submitEvidence(id, keccak256("x"), "");
    }

    // ------------------------------------------------------------------ proposals

    function test_propose_notDuringEvidenceWindow() public {
        uint256 id = _disputed();
        uint64 deadline = escrow.getEscrow(id).evidenceDeadline;
        vm.warp(deadline - 1);
        vm.expectRevert(abi.encodeWithSelector(MediatedEscrow.DeadlineNotReached.selector, deadline));
        vm.prank(mediator);
        escrow.propose(id, 1, keccak256("r"));
    }

    function test_propose_byOwnerKey() public {
        uint256 id = _disputed();
        vm.warp(vm.getBlockTimestamp() + EVIDENCE);
        vm.prank(mediator);
        escrow.propose(id, 400e6, keccak256("r"));
        MediatedEscrow.Escrow memory e = escrow.getEscrow(id);
        assertEq(uint8(e.status), uint8(MediatedEscrow.Status.Proposed));
        assertEq(e.proposer, mediator);
        assertEq(e.proposedPayeeAmount, 400e6);
        assertEq(e.responseDeadline, vm.getBlockTimestamp() + RESPONSE);
        assertEq(escrow.getMediator(mediator).proposals, 1);
        assertEq(escrow.getMediator(mediator).sessionBudget, 10, "owner key does not consume budget");
    }

    function test_propose_bySessionKeyConsumesBudget() public {
        uint256 id = _proposed(400e6);
        assertEq(escrow.getEscrow(id).proposer, sessionKey);
        assertEq(escrow.getMediator(mediator).sessionBudget, 9);
    }

    function test_propose_cannotExceedEscrow() public {
        uint256 id = _disputed();
        vm.warp(vm.getBlockTimestamp() + EVIDENCE);
        vm.expectRevert(abi.encodeWithSelector(MediatedEscrow.AmountExceedsEscrow.selector, AMOUNT + 1, AMOUNT));
        vm.prank(sessionKey);
        escrow.propose(id, AMOUNT + 1, keccak256("r"));
    }

    function test_propose_requiresReasoningHash() public {
        uint256 id = _disputed();
        vm.warp(vm.getBlockTimestamp() + EVIDENCE);
        vm.expectRevert(MediatedEscrow.EmptyHash.selector);
        vm.prank(sessionKey);
        escrow.propose(id, 1, bytes32(0));
    }

    function test_propose_onlyOnce() public {
        uint256 id = _proposed(400e6);
        vm.expectRevert(abi.encodeWithSelector(MediatedEscrow.WrongStatus.selector, MediatedEscrow.Status.Proposed));
        vm.prank(sessionKey);
        escrow.propose(id, 500e6, keccak256("r2"));
    }

    function test_propose_unauthorizedCallers() public {
        uint256 id = _disputed();
        vm.warp(vm.getBlockTimestamp() + EVIDENCE);
        address[3] memory bad = [payer, payee, stranger];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(MediatorRegistry.NotAuthorizedMediator.selector);
            vm.prank(bad[i]);
            escrow.propose(id, 1, keccak256("r"));
        }
    }

    function test_propose_anotherRegisteredMediatorCannotPropose() public {
        address other = makeAddr("other");
        vm.prank(other);
        escrow.registerMediator("other");
        uint256 id = _disputed();
        vm.warp(vm.getBlockTimestamp() + EVIDENCE);
        vm.expectRevert(MediatorRegistry.NotAuthorizedMediator.selector);
        vm.prank(other);
        escrow.propose(id, 1, keccak256("r"));
    }

    // ------------------------------------------------------------------ session keys

    function test_session_expiredKeyRejected() public {
        vm.prank(mediator);
        escrow.setSessionKey(sessionKey, uint64(vm.getBlockTimestamp() + 1 hours), 5);
        uint256 id = _disputed();
        assertTrue(escrow.canPropose(mediator, sessionKey));
        vm.warp(vm.getBlockTimestamp() + EVIDENCE); // key expired after 1h, propose window now open
        assertFalse(escrow.canPropose(mediator, sessionKey), "expired");
        vm.expectRevert(MediatorRegistry.NotAuthorizedMediator.selector);
        vm.prank(sessionKey);
        escrow.propose(id, 1, keccak256("r"));
    }

    function test_session_budgetExhausted() public {
        vm.prank(mediator);
        escrow.setSessionKey(sessionKey, uint64(vm.getBlockTimestamp() + 7 days), 1);
        uint256 a = _disputed();
        uint256 b = _disputed();
        vm.warp(vm.getBlockTimestamp() + EVIDENCE);
        vm.prank(sessionKey);
        escrow.propose(a, 1, keccak256("r"));
        vm.expectRevert(MediatorRegistry.NotAuthorizedMediator.selector);
        vm.prank(sessionKey);
        escrow.propose(b, 1, keccak256("r"));
        // Owner key still works.
        vm.prank(mediator);
        escrow.propose(b, 1, keccak256("r"));
    }

    function test_session_revocationIsInstant() public {
        uint256 id = _disputed();
        vm.warp(vm.getBlockTimestamp() + EVIDENCE);
        vm.prank(mediator);
        escrow.revokeSessionKey();
        vm.expectRevert(MediatorRegistry.NotAuthorizedMediator.selector);
        vm.prank(sessionKey);
        escrow.propose(id, 1, keccak256("r"));
    }

    function test_session_pausedMediatorCannotPropose() public {
        uint256 id = _disputed();
        vm.warp(vm.getBlockTimestamp() + EVIDENCE);
        vm.prank(mediator);
        escrow.updateMediator(false, "paused");
        vm.expectRevert(MediatorRegistry.NotAuthorizedMediator.selector);
        vm.prank(mediator);
        escrow.propose(id, 1, keccak256("r"));
    }

    function test_session_invalidParams() public {
        vm.startPrank(mediator);
        vm.expectRevert(MediatorRegistry.InvalidSessionKey.selector);
        escrow.setSessionKey(address(0), uint64(vm.getBlockTimestamp() + 1), 1);
        vm.expectRevert(MediatorRegistry.InvalidSessionKey.selector);
        escrow.setSessionKey(mediator, uint64(vm.getBlockTimestamp() + 1), 1);
        vm.expectRevert(MediatorRegistry.InvalidSessionExpiry.selector);
        escrow.setSessionKey(sessionKey, uint64(vm.getBlockTimestamp()), 1);
        vm.expectRevert(MediatorRegistry.InvalidSessionExpiry.selector);
        escrow.setSessionKey(sessionKey, uint64(vm.getBlockTimestamp() + 31 days), 1);
        vm.stopPrank();

        vm.expectRevert(MediatorRegistry.MediatorNotRegistered.selector);
        vm.prank(stranger);
        escrow.setSessionKey(sessionKey, uint64(vm.getBlockTimestamp() + 1), 1);
        vm.expectRevert(MediatorRegistry.MediatorAlreadyRegistered.selector);
        vm.prank(mediator);
        escrow.registerMediator("again");
    }

    function test_registry_listing() public view {
        assertEq(escrow.mediatorCount(), 1);
        assertEq(escrow.mediatorAt(0), mediator);
        assertEq(escrow.getMediator(mediator).metadataURI, "ipfs://fairhold-mediator");
    }

    // ------------------------------------------------------------------ responses

    function test_response_bothAcceptExecutesProposal() public {
        uint256 id = _proposed(650e6);
        vm.prank(payer);
        escrow.respondToProposal(id, true);
        assertEq(uint8(_status(id)), uint8(MediatedEscrow.Status.Proposed));
        vm.prank(payee);
        escrow.respondToProposal(id, true);
        _assertSettled(id, MediatedEscrow.Resolution.ProposalAccepted, 650e6);
        assertEq(escrow.getMediator(mediator).accepted, 1);
    }

    function test_response_rejectAppliesFallback() public {
        uint256 id = _proposed(650e6);
        vm.prank(payer);
        escrow.respondToProposal(id, true);
        vm.prank(payee);
        escrow.respondToProposal(id, false);
        _assertSettled(id, MediatedEscrow.Resolution.ProposalRejected, 500e6);
        assertEq(escrow.getMediator(mediator).rejected, 1);
    }

    function test_response_cannotRespondTwice() public {
        uint256 id = _proposed(650e6);
        vm.prank(payer);
        escrow.respondToProposal(id, true);
        vm.expectRevert(MediatedEscrow.AlreadyResponded.selector);
        vm.prank(payer);
        escrow.respondToProposal(id, false);
    }

    function test_response_onlyParties() public {
        uint256 id = _proposed(650e6);
        vm.expectRevert(MediatedEscrow.NotParty.selector);
        vm.prank(mediator);
        escrow.respondToProposal(id, true);
    }

    function test_response_unchallengedProposalExecutesAtDeadline() public {
        uint256 id = _proposed(650e6);
        uint64 deadline = escrow.getEscrow(id).responseDeadline;
        vm.prank(payer);
        escrow.respondToProposal(id, true); // payee silent

        vm.warp(deadline - 1);
        vm.expectRevert(MediatedEscrow.NothingToFinalize.selector);
        escrow.finalize(id);

        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(MediatedEscrow.DeadlinePassed.selector, deadline));
        vm.prank(payee);
        escrow.respondToProposal(id, false);

        vm.prank(stranger);
        escrow.finalize(id);
        _assertSettled(id, MediatedEscrow.Resolution.ProposalUnchallenged, 650e6);
        assertEq(escrow.getMediator(mediator).unchallenged, 1);
    }

    // ------------------------------------------------------------------ mediator timeout

    function test_mediatorTimeout_appliesFallback() public {
        uint256 id = _disputed();
        uint64 deadline = escrow.getEscrow(id).proposeDeadline;
        vm.warp(deadline - 1);
        vm.expectRevert(MediatedEscrow.NothingToFinalize.selector);
        escrow.finalize(id);

        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(MediatedEscrow.DeadlinePassed.selector, deadline));
        vm.prank(sessionKey);
        escrow.propose(id, 1, keccak256("r"));

        vm.prank(stranger);
        escrow.finalize(id);
        _assertSettled(id, MediatedEscrow.Resolution.MediatorTimeout, 500e6);
        assertEq(escrow.getMediator(mediator).missed, 1);
    }

    // ------------------------------------------------------------------ terminal-state safety

    function test_terminal_noFurtherActions() public {
        uint256 id = _active();
        vm.prank(payer);
        escrow.offerSettlement(id, 1e6);
        vm.prank(payee);
        escrow.offerSettlement(id, 1e6);

        vm.expectRevert(MediatedEscrow.NothingToFinalize.selector);
        escrow.finalize(id);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        vm.expectRevert(MediatedEscrow.NothingToFinalize.selector);
        escrow.finalize(id);

        bytes memory wrong = abi.encodeWithSelector(MediatedEscrow.WrongStatus.selector, MediatedEscrow.Status.Settled);
        vm.expectRevert(wrong);
        vm.prank(payer);
        escrow.offerSettlement(id, 1);
        vm.expectRevert(wrong);
        vm.prank(payer);
        escrow.openDispute(id);
        vm.expectRevert(wrong);
        vm.prank(payer);
        escrow.cancel(id);
        vm.expectRevert(wrong);
        vm.prank(payer);
        escrow.respondToProposal(id, true);
    }

    function test_unknownEscrowReverts() public {
        vm.expectRevert(MediatedEscrow.UnknownEscrow.selector);
        escrow.getEscrow(42);
        vm.expectRevert(MediatedEscrow.UnknownEscrow.selector);
        escrow.finalize(42);
    }

    function test_escrowsAreIsolated() public {
        uint256 a = _active();
        uint256 b = _active();
        vm.prank(payer);
        escrow.offerSettlement(a, 100e6);
        vm.prank(payee);
        escrow.offerSettlement(a, 100e6);
        assertEq(usd.balanceOf(address(escrow)), AMOUNT, "b still funded");
        assertEq(uint8(_status(b)), uint8(MediatedEscrow.Status.Active));
    }

    function test_reentrantTokenCannotDoubleSettle() public {
        ReentrantToken rt = new ReentrantToken();
        MediatedEscrow e2 = new MediatedEscrow(IERC20(address(rt)));
        vm.prank(mediator);
        e2.registerMediator("m");
        rt.mint(payer, AMOUNT * 2);
        vm.startPrank(payer);
        rt.approve(address(e2), type(uint256).max);
        uint256 id = e2.createEscrow(_terms());
        e2.createEscrow(_terms()); // second escrow funds that an attacker would like to steal
        vm.stopPrank();
        bytes32 d = e2.termsDigest(id);
        vm.prank(payee);
        e2.acceptTerms(id, d);

        rt.arm(e2, id);
        vm.warp(vm.getBlockTimestamp() + ACTIVE);
        e2.finalize(id); // the token tries to re-enter finalize() during the payout
        assertEq(rt.balanceOf(address(e2)), AMOUNT, "second escrow untouched");
        assertTrue(rt.reentryBlocked());
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_bpsSplitsAlwaysSumToAmount(uint128 amount, uint16 bps) public {
        amount = uint128(bound(amount, 1, 1e15));
        bps = uint16(bound(bps, 0, 10_000));
        usd.mint(payer, amount);
        MediatedEscrow.Terms memory t = _terms();
        t.amount = amount;
        t.undisputedPayeeBps = bps;
        vm.prank(payer);
        uint256 id = escrow.createEscrow(t);
        bytes32 d = escrow.termsDigest(id);
        vm.prank(payee);
        escrow.acceptTerms(id, d);
        vm.warp(vm.getBlockTimestamp() + ACTIVE);
        escrow.finalize(id);

        MediatedEscrow.Escrow memory e = escrow.getEscrow(id);
        assertEq(uint256(e.payeePaid) + e.payerPaid, amount);
        assertEq(e.payeePaid, (uint256(amount) * bps) / 10_000);
        assertEq(usd.balanceOf(address(escrow)), 0);
    }

    function testFuzz_proposalBoundedAndConserved(uint128 proposal, bool reject) public {
        proposal = uint128(bound(proposal, 0, AMOUNT));
        uint256 id = _proposed(proposal);
        uint256 payerBefore = usd.balanceOf(payer);
        vm.prank(payer);
        escrow.respondToProposal(id, !reject);
        if (!reject) {
            vm.prank(payee);
            escrow.respondToProposal(id, true);
        }
        MediatedEscrow.Escrow memory e = escrow.getEscrow(id);
        uint256 expectedPayee = reject ? 500e6 : proposal;
        assertEq(e.payeePaid, expectedPayee);
        assertEq(usd.balanceOf(payee), expectedPayee);
        assertEq(usd.balanceOf(payer), payerBefore + AMOUNT - expectedPayee);
        assertEq(usd.balanceOf(address(escrow)), 0);
    }

    function testFuzz_proposalAboveAmountAlwaysReverts(uint128 proposal) public {
        proposal = uint128(bound(proposal, uint256(AMOUNT) + 1, type(uint128).max));
        uint256 id = _disputed();
        vm.warp(vm.getBlockTimestamp() + EVIDENCE);
        vm.expectRevert(abi.encodeWithSelector(MediatedEscrow.AmountExceedsEscrow.selector, proposal, AMOUNT));
        vm.prank(sessionKey);
        escrow.propose(id, proposal, keccak256("r"));
    }

    function testFuzz_deadlineArithmetic(uint64 active, uint64 evidence, uint64 propose_, uint64 response) public {
        active = uint64(bound(active, 1 minutes, 365 days));
        evidence = uint64(bound(evidence, 1 minutes, 365 days));
        propose_ = uint64(bound(propose_, 1 minutes, 365 days));
        response = uint64(bound(response, 1 minutes, 365 days));
        MediatedEscrow.Terms memory t = _terms();
        t.activeDuration = active;
        t.evidenceWindow = evidence;
        t.proposeWindow = propose_;
        t.responseWindow = response;
        vm.prank(payer);
        uint256 id = escrow.createEscrow(t);
        bytes32 d = escrow.termsDigest(id);
        vm.prank(payee);
        escrow.acceptTerms(id, d);
        uint256 start = vm.getBlockTimestamp();
        vm.prank(payer);
        escrow.openDispute(id);
        MediatedEscrow.Escrow memory e = escrow.getEscrow(id);
        assertEq(e.activeDeadline, start + active);
        assertEq(e.evidenceDeadline, start + evidence);
        assertEq(e.proposeDeadline, start + evidence + propose_);
        vm.warp(e.proposeDeadline);
        escrow.finalize(id);
        assertEq(usd.balanceOf(address(escrow)), 0);
    }
}

/// @dev ERC-20 that attempts to re-enter the escrow when it transfers out.
contract ReentrantToken is MockUSD8 {
    MediatedEscrow internal target;
    uint256 internal targetId;
    bool public reentryBlocked;

    function arm(MediatedEscrow t, uint256 id) external {
        target = t;
        targetId = id;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(target) != address(0) && from == address(target)) {
            MediatedEscrow t = target;
            target = MediatedEscrow(address(0)); // one attempt
            try t.finalize(targetId) {}
            catch {
                reentryBlocked = true;
            }
        }
    }
}
