import type { Address, Hex } from "viem";

/**
 * Party-facing API calls are authenticated with wallet signatures (EIP-191 personal_sign).
 * Verification goes through `publicClient.verifyMessage`, which also accepts ERC-1271 smart
 * accounts and ERC-6492 counterfactual accounts — not only EOAs.
 */
export function uploadMessage(p: {
  chainId: number;
  escrow: Address;
  escrowId: bigint | string;
  contentHash: Hex;
  kind: "evidence" | "terms";
}): string {
  return [
    "FairHold evidence upload",
    `kind: ${p.kind}`,
    `chain: ${p.chainId}`,
    `escrow: ${p.escrow.toLowerCase()}`,
    `id: ${p.escrowId.toString()}`,
    `hash: ${p.contentHash.toLowerCase()}`,
  ].join("\n");
}

export function readMessage(p: {
  chainId: number;
  escrow: Address;
  escrowId: bigint | string;
  expires: number;
}): string {
  return [
    "FairHold evidence access",
    `chain: ${p.chainId}`,
    `escrow: ${p.escrow.toLowerCase()}`,
    `id: ${p.escrowId.toString()}`,
    `expires: ${p.expires}`,
  ].join("\n");
}

export const MAX_READ_GRANT_SECONDS = 3600;

export function readGrantIsFresh(expires: number, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return Number.isInteger(expires) && expires > nowSeconds && expires <= nowSeconds + MAX_READ_GRANT_SECONDS;
}
