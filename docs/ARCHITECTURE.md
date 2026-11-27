# FairHold Architecture

## Purpose

FairHold is a mediated escrow system for a payer and a payee. It holds a fixed
amount on-chain and resolves it through direct agreement, an AI-assisted
proposal, or deterministic deadline-based fallbacks.

The smart contract is the source of truth for escrow state and funds. The
mediator service can recommend a split, but it cannot transfer funds or
override the parties' accept/reject decisions.

> **Implementation status:** implemented. `contracts/src/MediatedEscrow.sol`
> (with `MediatorRegistry.sol`), the mediator service in `mediator/`, and the
> web app in `web/` follow this document. Implementation decisions that the
> original design left open are recorded in
> [Implementation Decisions](#implementation-decisions) at the end.

## System Overview

```text
Payer                         On-chain escrow                     Payee
  |                                |                                |
  | create / fund                  |                                |
  |------------------------------->|                                |
  | accept terms ----------------->|                                |
  |                                |<---------------- accept terms |
  | mutually offer a split ------->|                                |
  |                                |<------ mutually offer split    |
  |                                | execute if offers match        |
  |                                |-------------- payment -------->|

                Evidence and dispute requests
Payer <-----------------------------------------------------------> Payee
  |                                                                |
  | hash evidence / open dispute                                   |
  +--------------------------> contract <-------------------------+

                              Mediator service
  | observes state and reads evidence hashes
  | submits payee amount and reasoning hash
  +------------------------> contract
```

The system has three areas:

1. **Smart contracts** — custody funds, enforce deadlines and authorization,
   store dispute evidence hashes, and execute settlements.
2. **Mediator service** — examines public escrow data and evidence, produces a
   bounded payee proposal, and submits the proposal to the contract.
3. **Web application** — presents escrow state and deadline information,
   collects wallet-signed transactions, and uploads evidence for off-chain
   access without placing evidence contents on-chain.

## Repository Layout

| Path | Responsibility |
| --- | --- |
| `contracts/src/` | FairHold Solidity contracts. |
| `contracts/test/` | Contract unit and property tests. |
| `contracts/script/` | Deployment and operational scripts. |
| `contracts/lib/` | Foundry dependencies, including Forge Std and OpenZeppelin Contracts. |
| `mediator/` | Mediator API, wallet integration, proposal generation, and its tests. |
| `web/` | Next.js user interface and wallet interactions. |
| `docs/` | System and operator documentation. |

## Actors and Trust

| Actor | Responsibilities | On-chain capability |
| --- | --- | --- |
| Payer | Creates the escrow, funds it, accepts terms, submits evidence, and settles or disputes. | Payer operations and agreement acceptance. |
| Payee | Accepts terms, submits evidence, and settles or disputes. | Payee operations and agreement acceptance. |
| Mediator | Reviews evidence and submits one bounded proposal with a reasoning commitment. | A dedicated proposal key with no withdrawal or settlement authority beyond `propose`. |
| Anyone | May invoke permissionless deadline finalization after the applicable deadline. | Applies a configured fallback where the contract permits. |

The contract must not accept balances or splits derived solely from the
mediator service. All supported destinations, amounts, roles, deadlines, and
state transitions are checked on-chain.

## Escrow State

The intended lifecycle is:

```text
AwaitingPayee
      |
      | payee accepts terms
      v
Active
      |
      +-- mutual settlement matches --> Settled
      |
      +-- dispute opened
      v
Disputed
      |
      | evidence window closes
      v
Proposed
      |
      +-- both parties accept --> Settled
      |
      +-- either party rejects / response deadline expires
      v
Settled (fallback split)
```

Terminal states and cancellation are handled independently:

- **Cancelled:** the payer cancels before payee acceptance and receives the
  escrow refund.
- **Settled:** the contract transfers the final payer and payee amounts and
  releases all remaining value.

The exact Solidity enum names and transition guards should remain mirrored in
the web and mediator implementations.

## Creation and Funding

At creation the contract stores:

- payer address;
- payee address;
- escrow amount;
- `acceptBy` deadline;
- dispute evidence window;
- mediator proposal deadline;
- dispute fallback split;
- undisputed payee basis points; and
- mediator address.

Payer acceptance of the configured terms is part of creation or a separate
funding transaction, depending on the final contract API. The payee must
explicitly accept the same terms before `acceptBy`.

If the payee has not accepted terms by the deadline, the payer may cancel and
receive a refund. This prevents the payer from being able to bind the payee to
terms it never acknowledged.

## Settlement Flows

### Mutual settlement

Either party may submit a proposed payee amount. The contract stores that
party's offer. If both parties submit the same amount, the escrow is settled
immediately:

```text
payer offer + payee offer are equal
        |
        v
verify both amounts within escrow
        |
        v
pay the configured payee amount
pay the remainder to the payer
mark Settled
```

Mutual settlement remains available in the normal active state and requires no
mediator involvement.

### Dispute

Either party may open a dispute while the escrow is active. Opening a dispute:

1. records the dispute start block time;
2. fixes the evidence and proposal deadlines; and
3. transitions the escrow to `Disputed`.

During the evidence window, each party may submit one or more content hashes.
The contract stores only the hash and an anchor to the submitting party. Raw
evidence belongs in an off-chain evidence store and must not be assumed to
appear on-chain.

After the evidence window closes, the mediator may submit exactly one proposal.
The proposal contains:

- an amount payable to the payee; and
- a bytes32 reasoning hash that commits to the mediator's rationale.

The proposed amount must be between zero and the escrow balance. The contract
caps the accepted value at the actual escrow amount even if an erroneous or
malicious service proposes a larger amount.

### Party Responses

When a proposal exists:

- if both parties accept, the contract executes the proposed split immediately;
- if either party rejects, the configured dispute fallback split becomes
  effective as soon as the fallback deadline permits settlement;
- if neither party responds, the proposal may execute at the proposal
  deadline.

The response deadline should be enforced in the contract, not relied on by the
frontend or mediator.

### Undisputed fallback

If no dispute is opened and no finalization has occurred, anyone may finalize
after the active escrow's finalization deadline. The contract pays the
configured `undisputedPayeeBps` percentage to the payee and the remainder to
the payer.

The fallback bps is escrow-specific. For example, a rental deposit can default
to 0% for the payee and a prepayment can default to 100%.

### Mediator timeout

If the evidence window closes but the mediator never submits a proposal, anyone
may apply the configured dispute fallback after `proposeDeadline`. This
guarantees that funds do not depend on mediator liveness.

## Deadline Model

All contract deadlines are timestamps derived from block time and must be
stored as explicit values or predictable offsets. A deadline becomes actionable
when the current block timestamp is greater than or equal to it.

The mediator may assist before or around proposal deadlines, but deadline
permission is exclusively enforced by the contract. `cron` jobs, keeper services,
or the UI must never be the sole mechanism for settlement.

## Evidence Integrity

Evidence handling uses two layers:

1. **Content layer:** evidence files are hashed locally by the participant.
   The original file is never needed to verify that a known hash is unchanged.
2. **Commitment layer:** the hash and submitting address are stored by the
   contract.

The recommended evidence hash is `keccak256` of the canonical evidence bytes.
The web application should use a clear, versioned metadata format and include
the evidence type and timestamp outside the final hash calculation.

The hash stored on-chain proves a commitment but does not prove that the
off-chain evidence is authentic or that it belongs to the original event.
Authentication policy and authorized evidence retrieval remain mediator and
application responsibilities.

## Mediator Service

The mediator is an off-chain advisory service. Its intended flow is:

1. authenticate to the configured RPC and load the escrow contract state;
2. verify the dispute state and that the evidence window has closed;
3. fetch evidence only from an allowlisted storage location;
4. validate evidence against on-chain hashes;
5. calculate a bounded payee amount;
6. calculate a deterministic or content-addressed reasoning hash;
7. sign and submit the proposal using the dedicated mediator key.

The service must:

- limit the payee amount to the escrow balance;
- submit at most once for an escrow;
- validate contract state immediately before proposing;
- reject evidence that cannot be integrity-checked;
- keep secrets, private keys, provider credentials, and model credentials outside
  source control; and
- treat model output as untrusted data that must pass schema and range checks.

The service should expose health and job state without exposing private
evidence or private key material. API authentication is required for
party-facing operations when the service includes such endpoints.

## Web Application

The web application is an ordinary wallet-connected client. It should:

- read escrow state and deadlines from the chain;
- construct typed contract transactions;
- require wallet signatures for payer and payee actions;
- show clear pending, disputed, proposed, and settled states;
- hash evidence in the browser or through an approved local tool;
- display transaction failures and deadline consequences; and
- avoid storing private evidence or wallet credentials in browser state.

The UI must not infer or report a settlement as final until the relevant chain
transaction is confirmed. It should treat wallet, RPC, and service failures as
separate states.

## Security Boundaries

| Threat | Contract-side defense | Operational defense |
| --- | --- | --- |
| Mediator key compromise or prompt injection | Proposal key cannot withdraw directly and cannot exceed escrow bounds. Parties can reject or cause fallback settlement. | Rotate keys, restrict RPC signing, validate proposal schema, and alert on repeated or anomalous proposals. |
| Mediator offline | Proposal deadlines trigger deterministic fallback settlement. | Monitor proposal jobs and expose liveness metrics. |
| Evidence replaced after submission | Contract stores the original content hash. | Retrieve evidence from immutable or authenticated storage and verify hashes before review. |
| Payee never acknowledges terms | Payer may cancel after `acceptBy` and receive a refund. | Notify both parties before the acceptance deadline. |
| Parties become unavailable | Undisputed and fallback deadlines settle the escrow. | Keeper/notification service can remind parties but cannot become required for settlement. |
| Proposal exceeds escrow value | Contract caps or rejects proposed payee amount. | Use bounded integer arithmetic and validate in the service and tests. |
| Reentrancy or transfer failure | Settlement should use a protected state transition and safe transfer pattern. | Test failures and favor pull payments or one-time state updates where appropriate. |
| One party submits stale conflicting offers | Contract compares against the current escrow state and latest approved configuration. | Prevent UI race conditions and re-read state after confirmation. |

## Finalization Invariants

Before any settlement, the implementation must ensure:

1. only the authorized role or permissionless deadline path can settle;
2. payer and payee addresses are valid and distinct;
3. payer and payee payments sum to the escrow amount;
4. no funds remain locked after a terminal transition;
5. settlement executes once only;
6. deadline and state checks precede transfer calls;
7. integer arithmetic remains in a 0–10000 basis-point range; and
8. transfer failure cannot leave an incorrect settlement state.

## Transaction Guarantees

Settlement functions should follow the checks-effects-interactions pattern:

1. validate caller, role, state, and deadline;
2. validate split values;
3. mark the escrow `Settled`;
4. record final split values or settlement reason;
5. perform transfers.

This ordering limits reentrancy risk and ensures a reverted external transfer
does not produce an inconsistent in-memory state. Native ETH versus ERC-20
support must be selected deliberately; the contract API and tests must document
which asset is held.

## Testing Requirements

Contract tests should cover:

- creation and correct payer/payee roles;
- payee acceptance and payer cancellation;
- acceptance deadline edge cases;
- matching and mismatching mutual settlement offers;
- dispute opening, evidence-window boundaries, and evidence hash updates;
- mediator authorization and proposal limits;
- double proposal attempts;
- party accept and reject responses;
- mediator timeout fallback;
- undisputed fallback;
- settlement failure and repeated-finalization attempts;
- unauthorized callers; and
- fuzz tests for bps, balances, and deadline arithmetic.

Integration tests should verify:

- UI transaction construction and state rendering;
- evidence hash stability and evidence retrieval;
- mediator contract-state validation;
- proposal signing and submission;
- RPC and wallet error handling; and
- no single off-chain component is required for deadline finalization.

## Implementation Decisions

These choices were left open above and are now fixed by the code.

| Topic | Decision |
| --- | --- |
| Asset | One ERC-20 per deployment (tUSD8 on Aevum, 6 decimals). Fee-on-transfer tokens are rejected at funding by a balance-delta check. No native-coin escrows. |
| Payer acceptance | Creating and funding the escrow is the payer's acceptance. `createEscrowWithPermit` does it in one transaction with an EIP-2612 signature. |
| Payee acceptance | `acceptTerms(id, digest)` must quote `termsDigest(id)`, a hash of every immutable term bound to chain id, contract and escrow id. |
| Deadlines | Stored as durations at creation and turned into absolute timestamps when each phase starts: `activeDeadline` at acceptance, `evidenceDeadline` and `proposeDeadline` at dispute, `responseDeadline` at proposal. Every window is between 1 minute and 365 days. |
| Expired acceptance | After `acceptBy`, anyone may call `finalize` to refund the payer (`Resolution.Expired`). Before acceptance the payer can `cancel` at any time. |
| Mutual offers | Available in `Active`, `Disputed` and `Proposed`. Offers are reset on every state transition, so a stale pre-dispute offer can never match. A party can also `withdrawOffer`. |
| Evidence | Allowed while `Active` and during the dispute evidence window. At most 64 items per escrow, with 32 reserved for each party so one side cannot exhaust the list before or during a dispute. The contract stores only `(hash, submitter, timestamp)`. The URI is emitted in an event and never stored. |
| Proposal bounds | A `payeeAmount` above the escrow amount **reverts** (it is not capped). A zero `reasoningHash` reverts. |
| Rejection | Any rejection settles the dispute fallback split immediately. Silence until `responseDeadline` executes the proposal (`ProposalUnchallenged`). |
| Mediator identity | `MediatorRegistry` follows the ERC-8004 pattern: registered identity plus metadata URI, and reputation counters (`proposals`, `accepted`, `unchallenged`, `rejected`, `missed`) written only by the escrow's own state transitions. |
| Mediator key | The owner key stays cold. The AI service signs with a **session key** that can only call `propose`, expires (at most 30 days), has a proposal budget, and can be revoked instantly. A paused mediator cannot be chosen for new escrows and cannot propose. |
| Transfers | Push transfers via SafeERC20 after all state is written (checks-effects-interactions) plus `nonReentrant`. A failing transfer reverts the whole settlement. |
| Evidence store | The mediator service keeps evidence content-addressed by keccak256 and re-hashes it on every read. Uploads and reads are authenticated with wallet signatures (EIP-191, ERC-1271 compatible) from the escrow's payer or payee. State is namespaced per deployment (`<chainId>-<escrow address>`, with an owner marker) because escrow ids restart at 1 on every deployment; pre-namespace data is left in place, never auto-migrated. |
| Reasoning commitment | `reasoningHash = keccak256(canonical JSON of the decision document)`. Anyone can fetch it from `GET /reasoning/:hash` and recompute the hash. |

Solidity enums mirrored off-chain:

```text
Status:     None, AwaitingPayee, Active, Disputed, Proposed, Settled, Cancelled
Resolution: None, Mutual, ProposalAccepted, ProposalUnchallenged, ProposalRejected,
            MediatorTimeout, Undisputed, Cancelled, Expired
```
