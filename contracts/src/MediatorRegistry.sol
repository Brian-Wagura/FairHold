// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MediatorRegistry
/// @notice Identity, scoped session keys and outcome-based reputation for AI mediators.
/// @dev Inspired by ERC-8004 (trustless agents): a mediator has an on-chain identity
///      (its owner address + metadata URI), and a reputation that is *derived only from
///      on-chain outcomes* — never self-reported. The owner key stays cold; the AI service
///      runs with a session key that
///        - can only call `propose` (no custody, no settlement, no withdrawal),
///        - expires at `sessionExpiry`,
///        - has a hard budget of proposals it may submit, and
///        - can be revoked instantly by the owner.
abstract contract MediatorRegistry {
    struct Mediator {
        bool registered;
        bool active;
        address sessionKey;
        uint64 sessionExpiry;
        uint32 sessionBudget; // proposals the session key may still submit
        uint32 proposals; // proposals submitted
        uint32 accepted; // proposals both parties accepted
        uint32 unchallenged; // proposals that executed at the response deadline
        uint32 rejected; // proposals a party rejected (fallback applied)
        uint32 missed; // disputes where the mediator never proposed in time
        string metadataURI; // off-chain profile: model, policy, operator, fees
    }

    uint64 public constant MAX_SESSION_DURATION = 30 days;

    mapping(address => Mediator) internal _mediators;
    address[] internal _mediatorList;

    event MediatorRegistered(address indexed mediator, string metadataURI);
    event MediatorUpdated(address indexed mediator, bool active, string metadataURI);
    event SessionKeySet(address indexed mediator, address indexed sessionKey, uint64 expiry, uint32 budget);
    event SessionKeyRevoked(address indexed mediator, address indexed sessionKey);

    error MediatorAlreadyRegistered();
    error MediatorNotRegistered();
    error InvalidSessionKey();
    error InvalidSessionExpiry();
    error NotAuthorizedMediator();

    /// @notice Register `msg.sender` as a mediator identity.
    function registerMediator(string calldata metadataURI) external {
        Mediator storage m = _mediators[msg.sender];
        if (m.registered) revert MediatorAlreadyRegistered();
        m.registered = true;
        m.active = true;
        m.metadataURI = metadataURI;
        _mediatorList.push(msg.sender);
        emit MediatorRegistered(msg.sender, metadataURI);
    }

    /// @notice Pause/unpause the mediator or update its profile. A paused mediator cannot be
    ///         selected for new escrows and cannot propose; open disputes fall back on timeout.
    function updateMediator(bool active, string calldata metadataURI) external {
        Mediator storage m = _mediators[msg.sender];
        if (!m.registered) revert MediatorNotRegistered();
        m.active = active;
        m.metadataURI = metadataURI;
        emit MediatorUpdated(msg.sender, active, metadataURI);
    }

    /// @notice Grant a scoped, expiring, budgeted session key to the mediator's AI service.
    ///         Replaces any existing session key.
    function setSessionKey(address key, uint64 expiry, uint32 budget) external {
        Mediator storage m = _mediators[msg.sender];
        if (!m.registered) revert MediatorNotRegistered();
        if (key == address(0) || key == msg.sender) revert InvalidSessionKey();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_SESSION_DURATION) {
            revert InvalidSessionExpiry();
        }
        m.sessionKey = key;
        m.sessionExpiry = expiry;
        m.sessionBudget = budget;
        emit SessionKeySet(msg.sender, key, expiry, budget);
    }

    /// @notice Instantly revoke the current session key.
    function revokeSessionKey() external {
        Mediator storage m = _mediators[msg.sender];
        if (!m.registered) revert MediatorNotRegistered();
        address old = m.sessionKey;
        m.sessionKey = address(0);
        m.sessionExpiry = 0;
        m.sessionBudget = 0;
        emit SessionKeyRevoked(msg.sender, old);
    }

    function getMediator(address mediator) external view returns (Mediator memory) {
        return _mediators[mediator];
    }

    function mediatorCount() external view returns (uint256) {
        return _mediatorList.length;
    }

    function mediatorAt(uint256 index) external view returns (address) {
        return _mediatorList[index];
    }

    /// @notice True if `caller` may currently propose on behalf of `mediator`.
    function canPropose(address mediator, address caller) public view returns (bool) {
        Mediator storage m = _mediators[mediator];
        if (!m.registered || !m.active) return false;
        if (caller == mediator) return true;
        return
            caller != address(0) && caller == m.sessionKey && block.timestamp < m.sessionExpiry && m.sessionBudget > 0;
    }

    /// @dev Authorize a proposal and consume one unit of session budget when a session key is used.
    function _consumeProposalAuthority(address mediator, address caller) internal {
        if (!canPropose(mediator, caller)) revert NotAuthorizedMediator();
        Mediator storage m = _mediators[mediator];
        if (caller != mediator) {
            unchecked {
                m.sessionBudget -= 1;
            }
        }
        unchecked {
            m.proposals += 1;
        }
    }

    function _isSelectableMediator(address mediator) internal view returns (bool) {
        Mediator storage m = _mediators[mediator];
        return m.registered && m.active;
    }
}
