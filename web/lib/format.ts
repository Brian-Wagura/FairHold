import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, formatUnits, parseUnits } from "viem";
import { config } from "./config";

export const fmtAmount = (v: bigint) =>
  Number(formatUnits(v, config.tokenDecimals)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const parseAmount = (s: string) => parseUnits(s.trim() || "0", config.tokenDecimals);

export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

export const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const fmtDate = (unix: number | bigint) =>
  new Date(Number(unix) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const FRIENDLY: Record<string, string> = {
  InvalidTerms: "These terms aren't valid",
  UnknownEscrow: "That escrow doesn't exist on this contract.",
  WrongStatus: "This action isn't available at the escrow's current stage. The page has been refreshed.",
  NotParty: "Only the payer or payee of this escrow can do that.",
  NotPayer: "Only the payer can do that.",
  NotPayee: "Only the payee can do that.",
  DeadlineNotReached: "Too early: the deadline for this step hasn't been reached yet.",
  DeadlinePassed: "Too late: the deadline for this step has passed. Use Finalize to apply the outcome.",
  AmountExceedsEscrow: "The amount is larger than the escrowed funds.",
  TermsMismatch: "The terms changed since you loaded them. Reload and review before accepting.",
  EvidenceLimitReached: "This escrow already has the maximum number of evidence items.",
  EmptyHash: "A file hash is required.",
  AlreadyResponded: "You already responded to this proposal.",
  UnsupportedToken: "The token transfer didn't deliver the exact amount.",
  NothingToFinalize: "Nothing to finalize yet: no deadline has passed.",
  NotAuthorizedMediator: "This key isn't allowed to propose for the mediator (expired, revoked, paused or out of budget).",
  MediatorAlreadyRegistered: "This address is already registered as a mediator.",
  MediatorNotRegistered: "Register as a mediator first.",
  InvalidSessionKey: "Session key must be a different, non-zero address.",
  InvalidSessionExpiry: "Session expiry must be in the future and at most 30 days away.",
  ERC20InsufficientBalance: "Your tUSD8 balance is too low. Use the faucet first.",
  ERC20InsufficientAllowance: "The escrow contract isn't approved to move that much tUSD8.",
};

/** Plain-language error text. Wallet, contract and network failures are kept distinct. */
export function explainError(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return "You rejected the request in your wallet. Nothing was sent.";
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? "";
      const base = FRIENDLY[name];
      if (name === "InvalidTerms") return `${base}: ${String(revert.data?.args?.[0] ?? "")}.`;
      if (base) return base;
      return `The contract rejected the transaction (${name || revert.shortMessage}).`;
    }
    if (/fetch|network|timeout|HTTP request failed/i.test(err.shortMessage)) {
      return "Couldn't reach the Aevum RPC. Check your connection and try again.";
    }
    if (/insufficient funds/i.test(err.message)) return "Not enough tQDAY for gas. Get some from the faucet.";
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}
