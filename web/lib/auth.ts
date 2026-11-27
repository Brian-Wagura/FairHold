import type { Address, Hex } from "viem";

// Must match mediator/src/auth.ts byte for byte.
export function uploadMessage(p: { chainId: number; escrow: Address; escrowId: bigint | string; contentHash: Hex; kind: "evidence" | "terms" }) {
  return [
    "FairHold evidence upload",
    `kind: ${p.kind}`,
    `chain: ${p.chainId}`,
    `escrow: ${p.escrow.toLowerCase()}`,
    `id: ${p.escrowId.toString()}`,
    `hash: ${p.contentHash.toLowerCase()}`,
  ].join("\n");
}

export function readMessage(p: { chainId: number; escrow: Address; escrowId: bigint | string; expires: number }) {
  return [
    "FairHold evidence access",
    `chain: ${p.chainId}`,
    `escrow: ${p.escrow.toLowerCase()}`,
    `id: ${p.escrowId.toString()}`,
    `expires: ${p.expires}`,
  ].join("\n");
}
