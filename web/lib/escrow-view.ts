import { Resolution, Status, type Escrow } from "./chain";
import { pct } from "./format";

/**
 * Presentation helpers: plain-language description of where an escrow is, what the deadline
 * is and what happens if nobody acts. Mirrors the contract's rules; never decides anything.
 */
export interface PhaseView {
  title: string;
  body: string;
  /** What the contract does automatically at `deadline` if nobody acts. */
  ifNobodyActs?: string;
  deadline?: bigint;
  start?: bigint;
  deadlineLabel?: string;
}

export function describePhase(e: Escrow, now: bigint): PhaseView {
  switch (e.status) {
    case Status.AwaitingPayee:
      return {
        title: "Waiting for the payee to accept",
        body: "The funds are locked. The payee needs to review and accept the terms before work begins.",
        ifNobodyActs: "If the payee doesn't accept in time, the payer can be refunded in full.",
        deadline: e.acceptBy,
        start: e.createdAt,
        deadlineLabel: "Acceptance closes",
      };
    case Status.Active:
      return {
        title: "Active: work in progress",
        body: "Both parties agreed. You can settle early by agreeing on a split, or open a dispute if something goes wrong.",
        ifNobodyActs: `If nobody disputes, the payee automatically receives ${pct(e.undisputedPayeeBps)}.`,
        deadline: e.activeDeadline,
        start: e.activeDeadline - e.activeDuration,
        deadlineLabel: "Dispute period ends",
      };
    case Status.Disputed:
      if (now < e.evidenceDeadline) {
        return {
          title: "In dispute: collecting evidence",
          body: "Both sides can add evidence now. When the window closes, the AI mediator reviews the hash-verified files and proposes a split.",
          ifNobodyActs: "When the window closes, the mediator takes over. No action is needed from you.",
          deadline: e.evidenceDeadline,
          start: e.evidenceDeadline - e.evidenceWindow,
          deadlineLabel: "Evidence closes",
        };
      }
      return {
        title: "Evidence closed: mediator reviewing",
        body: "The mediator is reviewing the evidence. Funds never depend on it: if it's late, the pre-agreed fallback applies.",
        ifNobodyActs: `If no proposal arrives in time, the payee receives ${pct(e.disputeFallbackPayeeBps)}.`,
        deadline: e.proposeDeadline,
        start: e.evidenceDeadline,
        deadlineLabel: "Mediator deadline",
      };
    case Status.Proposed:
      return {
        title: "The mediator proposed a split",
        body: `Both accept → it executes now. Either rejects → the fallback (payee ${pct(e.disputeFallbackPayeeBps)}) executes now.`,
        ifNobodyActs: "If nobody rejects in time, the proposal executes as written.",
        deadline: e.responseDeadline,
        start: e.responseDeadline - e.responseWindow,
        deadlineLabel: "Responses close",
      };
    case Status.Settled:
      return { title: "Settled", body: `${Resolution[e.resolution]}. Funds were paid out in the same transaction.` };
    case Status.Cancelled:
      return { title: "Refunded to the payer", body: `${Resolution[e.resolution]}. The full amount went back to the payer.` };
    default:
      return { title: "Unknown state", body: "" };
  }
}

export type Role = "payer" | "payee" | "mediator" | "observer";

export function roleOf(e: Escrow, account?: string): Role {
  const me = account?.toLowerCase();
  if (!me) return "observer";
  if (me === e.payer.toLowerCase()) return "payer";
  if (me === e.payee.toLowerCase()) return "payee";
  if (me === e.mediator.toLowerCase()) return "mediator";
  return "observer";
}

/** Short call to action when this account is expected to do something now. */
export function actionNeeded(e: Escrow, account: string | undefined, now: bigint): string | undefined {
  const role = roleOf(e, account);
  if (role !== "payer" && role !== "payee") return undefined;
  if (e.status === Status.AwaitingPayee && role === "payee" && now < e.acceptBy) return "Accept terms";
  if (e.status === Status.Disputed && now < e.evidenceDeadline) return "Add evidence";
  if (e.status === Status.Proposed && now < e.responseDeadline) {
    const responded = role === "payer" ? e.payerAcceptedProposal : e.payeeAcceptedProposal;
    if (!responded) return "Review proposal";
  }
  if (finalizeReady(e, now)) return "Ready to finalize";
  return undefined;
}

export function finalizeReady(e: Escrow, now: bigint): boolean {
  return (
    (e.status === Status.AwaitingPayee && now >= e.acceptBy) ||
    (e.status === Status.Active && now >= e.activeDeadline) ||
    (e.status === Status.Disputed && now >= e.proposeDeadline) ||
    (e.status === Status.Proposed && now >= e.responseDeadline)
  );
}

export const isOpen = (e: Escrow) => e.status >= Status.AwaitingPayee && e.status <= Status.Proposed;

export const ROLE_LABEL: Record<Role, string> = { payer: "Payer", payee: "Payee", mediator: "Mediator", observer: "Viewer" };
