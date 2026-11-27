// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {MediatorRegistry} from "./MediatorRegistry.sol";

/// @title FairHold MediatedEscrow
/// @notice Payer/payee escrow of a single ERC-20 (tUSD8 on Aevum) that resolves by mutual
///         agreement, a bounded AI-mediator proposal, or deterministic deadline fallbacks.
/// @dev The mediator can only *recommend*: it never custodies funds, cannot settle without the
///      parties' consent or a deadline, and its proposal is bounded by the escrow amount.
///      Every terminal path is reachable without any off-chain component (`finalize` is
///      permissionless once a deadline passes).
contract MediatedEscrow is MediatorRegistry, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    uint16 public constant BPS = 10_000;
    uint64 public constant MIN_WINDOW = 1 minutes;
    uint64 public constant MAX_WINDOW = 365 days;
    uint256 public constant MAX_EVIDENCE = 64;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Status {
        None,
        AwaitingPayee,
        Active,
        Disputed,
        Proposed,
        Settled,
        Cancelled
    }

    enum Resolution {
        None,
        Mutual, // both parties offered the same split
        ProposalAccepted, // both parties accepted the mediator proposal
        ProposalUnchallenged, // nobody rejected before the response deadline
        ProposalRejected, // a party rejected -> dispute fallback split
        MediatorTimeout, // mediator never proposed -> dispute fallback split
        Undisputed, // active deadline passed with no dispute -> undisputed split
        Cancelled, // payer cancelled before payee acceptance
        Expired // payee never accepted by acceptBy -> refund
    }

    /// @notice Terms chosen by the payer at creation. Durations are seconds.
    struct Terms {
        address payee;
        address mediator;
        uint128 amount;
        uint64 acceptBy; // absolute timestamp; payee must accept before this
        uint64 activeDuration; // from acceptance until the undisputed fallback is available
        uint64 evidenceWindow; // from dispute opening until the mediator may propose
        uint64 proposeWindow; // from evidence close until mediator timeout
        uint64 responseWindow; // from proposal until it executes if unchallenged
        uint16 undisputedPayeeBps; // payee share if nobody disputes
        uint16 disputeFallbackPayeeBps; // payee share if mediation fails
        bytes32 termsHash; // keccak256 of the off-chain agreement text
    }

    struct Escrow {
        address payer;
        Status status;
        Resolution resolution;
        address payee;
        address mediator;
        uint128 amount;
        uint64 createdAt;
        uint64 acceptBy;
        uint64 activeDuration;
        uint64 evidenceWindow;
        uint64 proposeWindow;
        uint64 responseWindow;
        uint16 undisputedPayeeBps;
        uint16 disputeFallbackPayeeBps;
        bytes32 termsHash;
        // Deadlines set as the escrow progresses.
        uint64 activeDeadline;
        uint64 evidenceDeadline;
        uint64 proposeDeadline;
        uint64 responseDeadline;
        address disputedBy;
        // Mutual-settlement offers (reset on every state transition).
        bool payerOffered;
        bool payeeOffered;
        uint128 payerOffer;
        uint128 payeeOffer;
        // Mediator proposal.
        address proposer; // mediator owner or its session key
        uint128 proposedPayeeAmount;
        bytes32 reasoningHash;
        bool payerAcceptedProposal;
        bool payeeAcceptedProposal;
        // Final split.
        uint128 payeePaid;
        uint128 payerPaid;
        uint64 settledAt;
    }

    struct Evidence {
        bytes32 contentHash;
        address submitter;
        uint64 submittedAt;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    IERC20 public immutable token;

    uint256 public escrowCount;
    mapping(uint256 => Escrow) internal _escrows;
    mapping(uint256 => Evidence[]) internal _evidence;
    mapping(address => uint256[]) internal _escrowsByAccount;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event EscrowCreated(
        uint256 indexed id,
        address indexed payer,
        address indexed payee,
        address mediator,
        uint256 amount,
        uint64 acceptBy,
        bytes32 termsHash
    );
    event TermsAccepted(uint256 indexed id, address indexed payee, uint64 activeDeadline);
    event OfferMade(uint256 indexed id, address indexed party, uint256 payeeAmount);
    event OfferWithdrawn(uint256 indexed id, address indexed party);
    event DisputeOpened(uint256 indexed id, address indexed by, uint64 evidenceDeadline, uint64 proposeDeadline);
    event EvidenceSubmitted(
        uint256 indexed id, address indexed submitter, uint256 index, bytes32 contentHash, string uri
    );
    event Proposed(
        uint256 indexed id,
        address indexed mediator,
        address indexed signer,
        uint256 payeeAmount,
        bytes32 reasoningHash,
        uint64 responseDeadline
    );
    event ProposalResponse(uint256 indexed id, address indexed party, bool accepted);
    event Settled(uint256 indexed id, Resolution indexed resolution, uint256 payeeAmount, uint256 payerAmount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error InvalidTerms(string reason);
    error UnknownEscrow();
    error WrongStatus(Status actual);
    error NotParty();
    error NotPayer();
    error NotPayee();
    error DeadlineNotReached(uint64 deadline);
    error DeadlinePassed(uint64 deadline);
    error AmountExceedsEscrow(uint256 amount, uint256 escrowAmount);
    error TermsMismatch();
    error EvidenceLimitReached();
    error EmptyHash();
    error AlreadyResponded();
    error UnsupportedToken();
    error NothingToFinalize();

    constructor(IERC20 token_) {
        if (address(token_) == address(0)) revert UnsupportedToken();
        token = token_;
    }

    // ---------------------------------------------------------------------
    // Creation
    // ---------------------------------------------------------------------

    /// @notice Create and fund an escrow. Requires a prior `approve` of `terms.amount`.
    ///         Creating the escrow is the payer's acceptance of `terms`.
    function createEscrow(Terms calldata terms) external nonReentrant returns (uint256 id) {
        id = _record(terms);
        _pullFunds(terms.amount);
    }

    /// @notice Create and fund an escrow in one transaction using an EIP-2612 permit signature.
    /// @dev The permit is wrapped in try/catch so a front-run permit cannot grief creation;
    ///      the subsequent transferFrom still enforces the allowance. State and the
    ///      `EscrowCreated` event are written before any external call (checks-effects-interactions).
    function createEscrowWithPermit(Terms calldata terms, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
        returns (uint256 id)
    {
        id = _record(terms);
        try IERC20Permit(address(token)).permit(msg.sender, address(this), terms.amount, permitDeadline, v, r, s) {}
            catch {}
        _pullFunds(terms.amount);
    }

    /// @dev Effects only: validates and records the escrow and emits its event. No external calls.
    function _record(Terms calldata t) internal returns (uint256 id) {
        _validateTerms(t);

        id = ++escrowCount;
        Escrow storage e = _escrows[id];
        e.payer = msg.sender;
        e.status = Status.AwaitingPayee;
        e.payee = t.payee;
        e.mediator = t.mediator;
        e.amount = t.amount;
        e.createdAt = _now();
        e.acceptBy = t.acceptBy;
        e.activeDuration = t.activeDuration;
        e.evidenceWindow = t.evidenceWindow;
        e.proposeWindow = t.proposeWindow;
        e.responseWindow = t.responseWindow;
        e.undisputedPayeeBps = t.undisputedPayeeBps;
        e.disputeFallbackPayeeBps = t.disputeFallbackPayeeBps;
        e.termsHash = t.termsHash;

        _escrowsByAccount[msg.sender].push(id);
        _escrowsByAccount[t.payee].push(id);
        _escrowsByAccount[t.mediator].push(id);

        emit EscrowCreated(id, msg.sender, t.payee, t.mediator, t.amount, t.acceptBy, t.termsHash);
    }

    /// @dev Interaction: pulls exactly `amount` from the payer. Fee-on-transfer and rebasing
    ///      tokens are rejected so the invariant "payouts sum to amount" always holds.
    function _pullFunds(uint128 amount) internal {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        // Exact equality is the point: any other delta means the token is not a plain ERC-20.
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (token.balanceOf(address(this)) - before != amount) revert UnsupportedToken();
    }

    function _validateTerms(Terms calldata t) internal view {
        if (t.payee == address(0)) revert InvalidTerms("payee is zero");
        if (t.payee == msg.sender) revert InvalidTerms("payee is payer");
        if (t.mediator == msg.sender || t.mediator == t.payee) revert InvalidTerms("mediator is a party");
        if (!_isSelectableMediator(t.mediator)) revert InvalidTerms("mediator not active");
        if (t.amount == 0) revert InvalidTerms("amount is zero");
        if (t.acceptBy <= block.timestamp) revert InvalidTerms("acceptBy in past");
        if (t.acceptBy > block.timestamp + MAX_WINDOW) revert InvalidTerms("acceptBy too far");
        _checkWindow(t.activeDuration);
        _checkWindow(t.evidenceWindow);
        _checkWindow(t.proposeWindow);
        _checkWindow(t.responseWindow);
        if (t.undisputedPayeeBps > BPS || t.disputeFallbackPayeeBps > BPS) revert InvalidTerms("bps > 10000");
    }

    function _checkWindow(uint64 w) private pure {
        if (w < MIN_WINDOW || w > MAX_WINDOW) revert InvalidTerms("window out of range");
    }

    // ---------------------------------------------------------------------
    // Acceptance / cancellation
    // ---------------------------------------------------------------------

    /// @notice Payee accepts the exact terms identified by `expectedDigest` (see `termsDigest`).
    ///         Binding the digest prevents a UI from showing one set of terms and signing another.
    function acceptTerms(uint256 id, bytes32 expectedDigest) external {
        Escrow storage e = _get(id);
        if (msg.sender != e.payee) revert NotPayee();
        _requireStatus(e, Status.AwaitingPayee);
        if (block.timestamp >= e.acceptBy) revert DeadlinePassed(e.acceptBy);
        if (expectedDigest != termsDigest(id)) revert TermsMismatch();

        e.status = Status.Active;
        e.activeDeadline = _now() + e.activeDuration;
        emit TermsAccepted(id, msg.sender, e.activeDeadline);
    }

    /// @notice Payer cancels before the payee has accepted and is refunded in full.
    function cancel(uint256 id) external nonReentrant {
        Escrow storage e = _get(id);
        if (msg.sender != e.payer) revert NotPayer();
        _requireStatus(e, Status.AwaitingPayee);
        _settle(id, e, 0, Resolution.Cancelled);
    }

    // ---------------------------------------------------------------------
    // Mutual settlement
    // ---------------------------------------------------------------------

    /// @notice Offer a split. If the counterparty's standing offer is identical, settles immediately.
    ///         Available while Active, Disputed or Proposed — the parties can always agree.
    function offerSettlement(uint256 id, uint128 payeeAmount) external nonReentrant {
        Escrow storage e = _get(id);
        _requireOpen(e);
        if (payeeAmount > e.amount) revert AmountExceedsEscrow(payeeAmount, e.amount);

        if (msg.sender == e.payer) {
            e.payerOffered = true;
            e.payerOffer = payeeAmount;
        } else if (msg.sender == e.payee) {
            e.payeeOffered = true;
            e.payeeOffer = payeeAmount;
        } else {
            revert NotParty();
        }
        emit OfferMade(id, msg.sender, payeeAmount);

        if (e.payerOffered && e.payeeOffered && e.payerOffer == e.payeeOffer) {
            _settle(id, e, payeeAmount, Resolution.Mutual);
        }
    }

    function withdrawOffer(uint256 id) external {
        Escrow storage e = _get(id);
        _requireOpen(e);
        if (msg.sender == e.payer) {
            e.payerOffered = false;
            e.payerOffer = 0;
        } else if (msg.sender == e.payee) {
            e.payeeOffered = false;
            e.payeeOffer = 0;
        } else {
            revert NotParty();
        }
        emit OfferWithdrawn(id, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Dispute, evidence and mediation
    // ---------------------------------------------------------------------

    function openDispute(uint256 id) external {
        Escrow storage e = _get(id);
        _requireParty(e);
        _requireStatus(e, Status.Active);
        if (block.timestamp >= e.activeDeadline) revert DeadlinePassed(e.activeDeadline);

        e.status = Status.Disputed;
        e.disputedBy = msg.sender;
        e.evidenceDeadline = _now() + e.evidenceWindow;
        e.proposeDeadline = e.evidenceDeadline + e.proposeWindow;
        _resetOffers(e);
        emit DisputeOpened(id, msg.sender, e.evidenceDeadline, e.proposeDeadline);
    }

    /// @notice Commit an evidence hash (keccak256 of the evidence bytes). `uri` is emitted only,
    ///         never stored, and points at the off-chain evidence store.
    function submitEvidence(uint256 id, bytes32 contentHash, string calldata uri) external {
        Escrow storage e = _get(id);
        _requireParty(e);
        if (contentHash == bytes32(0)) revert EmptyHash();
        if (e.status == Status.Disputed) {
            if (block.timestamp >= e.evidenceDeadline) revert DeadlinePassed(e.evidenceDeadline);
        } else if (e.status != Status.Active) {
            revert WrongStatus(e.status);
        }
        Evidence[] storage list = _evidence[id];
        if (list.length >= MAX_EVIDENCE) revert EvidenceLimitReached();
        list.push(Evidence({contentHash: contentHash, submitter: msg.sender, submittedAt: _now()}));
        emit EvidenceSubmitted(id, msg.sender, list.length - 1, contentHash, uri);
    }

    /// @notice Mediator (or its scoped session key) submits its single proposal once the
    ///         evidence window has closed and before the mediator timeout.
    function propose(uint256 id, uint128 payeeAmount, bytes32 reasoningHash) external {
        Escrow storage e = _get(id);
        _requireStatus(e, Status.Disputed);
        if (block.timestamp < e.evidenceDeadline) revert DeadlineNotReached(e.evidenceDeadline);
        if (block.timestamp >= e.proposeDeadline) revert DeadlinePassed(e.proposeDeadline);
        if (payeeAmount > e.amount) revert AmountExceedsEscrow(payeeAmount, e.amount);
        if (reasoningHash == bytes32(0)) revert EmptyHash();
        _consumeProposalAuthority(e.mediator, msg.sender);

        e.status = Status.Proposed;
        e.proposer = msg.sender;
        e.proposedPayeeAmount = payeeAmount;
        e.reasoningHash = reasoningHash;
        e.responseDeadline = _now() + e.responseWindow;
        _resetOffers(e);
        emit Proposed(id, e.mediator, msg.sender, payeeAmount, reasoningHash, e.responseDeadline);
    }

    /// @notice Accept or reject the mediator proposal. Both accepts execute it immediately;
    ///         any reject applies the pre-agreed dispute fallback split immediately.
    function respondToProposal(uint256 id, bool accept) external nonReentrant {
        Escrow storage e = _get(id);
        _requireParty(e);
        _requireStatus(e, Status.Proposed);
        if (block.timestamp >= e.responseDeadline) revert DeadlinePassed(e.responseDeadline);

        bool isPayer = msg.sender == e.payer;
        if (isPayer ? e.payerAcceptedProposal : e.payeeAcceptedProposal) revert AlreadyResponded();
        emit ProposalResponse(id, msg.sender, accept);

        if (!accept) {
            _mediators[e.mediator].rejected += 1;
            _settle(id, e, _bps(e.amount, e.disputeFallbackPayeeBps), Resolution.ProposalRejected);
            return;
        }
        if (isPayer) e.payerAcceptedProposal = true;
        else e.payeeAcceptedProposal = true;

        if (e.payerAcceptedProposal && e.payeeAcceptedProposal) {
            _mediators[e.mediator].accepted += 1;
            _settle(id, e, e.proposedPayeeAmount, Resolution.ProposalAccepted);
        }
    }

    // ---------------------------------------------------------------------
    // Permissionless deadline finalization
    // ---------------------------------------------------------------------

    /// @notice Anyone may apply the deterministic outcome once the relevant deadline passes.
    function finalize(uint256 id) external nonReentrant {
        Escrow storage e = _get(id);
        (bool ready, Resolution resolution, uint128 payeeAmount) = _finalization(e);
        if (!ready) revert NothingToFinalize();
        if (resolution == Resolution.ProposalUnchallenged) _mediators[e.mediator].unchallenged += 1;
        else if (resolution == Resolution.MediatorTimeout) _mediators[e.mediator].missed += 1;
        _settle(id, e, payeeAmount, resolution);
    }

    /// @notice Preview what `finalize` would do right now (for UIs and keepers).
    function previewFinalize(uint256 id)
        external
        view
        returns (bool ready, Resolution resolution, uint128 payeeAmount)
    {
        return _finalization(_get(id));
    }

    function _finalization(Escrow storage e)
        internal
        view
        returns (bool ready, Resolution resolution, uint128 payeeAmount)
    {
        uint256 nowTs = block.timestamp;
        Status s = e.status;
        if (s == Status.AwaitingPayee && nowTs >= e.acceptBy) {
            return (true, Resolution.Expired, 0);
        }
        if (s == Status.Active && nowTs >= e.activeDeadline) {
            return (true, Resolution.Undisputed, _bps(e.amount, e.undisputedPayeeBps));
        }
        if (s == Status.Disputed && nowTs >= e.proposeDeadline) {
            return (true, Resolution.MediatorTimeout, _bps(e.amount, e.disputeFallbackPayeeBps));
        }
        if (s == Status.Proposed && nowTs >= e.responseDeadline) {
            return (true, Resolution.ProposalUnchallenged, e.proposedPayeeAmount);
        }
        return (false, Resolution.None, 0);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getEscrow(uint256 id) external view returns (Escrow memory) {
        return _get(id);
    }

    function getEvidence(uint256 id) external view returns (Evidence[] memory) {
        return _evidence[id];
    }

    function escrowsOf(address account) external view returns (uint256[] memory) {
        return _escrowsByAccount[account];
    }

    /// @notice Digest of every immutable term of escrow `id`, bound to this chain and contract.
    function termsDigest(uint256 id) public view returns (bytes32) {
        Escrow storage e = _get(id);
        bytes32 parties = keccak256(abi.encode(e.payer, e.payee, e.mediator, e.amount, e.termsHash));
        bytes32 schedule = keccak256(
            abi.encode(
                e.acceptBy,
                e.activeDuration,
                e.evidenceWindow,
                e.proposeWindow,
                e.responseWindow,
                e.undisputedPayeeBps,
                e.disputeFallbackPayeeBps
            )
        );
        return keccak256(abi.encode(block.chainid, address(this), id, parties, schedule));
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev Checks-effects-interactions: all state is final before any transfer. A reverting
    ///      transfer reverts the whole transaction, so state can never claim a payout that
    ///      did not happen.
    function _settle(uint256 id, Escrow storage e, uint128 payeeAmount, Resolution resolution) internal {
        uint128 amount = e.amount;
        // Defence in depth: every caller already bounds payeeAmount.
        if (payeeAmount > amount) revert AmountExceedsEscrow(payeeAmount, amount);
        uint128 payerAmount = amount - payeeAmount;

        bool cancelled = resolution == Resolution.Cancelled || resolution == Resolution.Expired;
        e.status = cancelled ? Status.Cancelled : Status.Settled;
        e.resolution = resolution;
        e.payeePaid = payeeAmount;
        e.payerPaid = payerAmount;
        e.settledAt = _now();
        _resetOffers(e);

        emit Settled(id, resolution, payeeAmount, payerAmount);

        if (payeeAmount > 0) token.safeTransfer(e.payee, payeeAmount);
        if (payerAmount > 0) token.safeTransfer(e.payer, payerAmount);
    }

    function _bps(uint128 amount, uint16 bps) internal pure returns (uint128) {
        // amount < 2^128 and bps <= 10_000, so the product fits comfortably in uint256.
        // casting to 'uint128' is safe because bps <= BPS, so the result is <= amount < 2^128.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128((uint256(amount) * bps) / BPS);
    }

    function _now() internal view returns (uint64) {
        // casting to 'uint64' is safe because block timestamps fit in uint64 for ~584 billion years.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.timestamp);
    }

    function _resetOffers(Escrow storage e) private {
        e.payerOffered = false;
        e.payeeOffered = false;
        e.payerOffer = 0;
        e.payeeOffer = 0;
    }

    function _get(uint256 id) internal view returns (Escrow storage e) {
        e = _escrows[id];
        if (e.status == Status.None) revert UnknownEscrow();
    }

    function _requireStatus(Escrow storage e, Status s) private view {
        if (e.status != s) revert WrongStatus(e.status);
    }

    function _requireOpen(Escrow storage e) private view {
        Status s = e.status;
        if (s != Status.Active && s != Status.Disputed && s != Status.Proposed) revert WrongStatus(s);
    }

    function _requireParty(Escrow storage e) private view {
        if (msg.sender != e.payer && msg.sender != e.payee) revert NotParty();
    }
}
