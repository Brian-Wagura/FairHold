"use client";

import { keccak256, toBytes, type Address, type Hex, type WalletClient } from "viem";
import { readMessage, uploadMessage } from "./auth";
import { config } from "./config";

export class MediatorApiError extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.mediatorApi}${path}`, init);
  } catch {
    throw new MediatorApiError("The mediator service is unreachable. On-chain actions still work; evidence uploads need the service.");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; details?: string[] };
    throw new MediatorApiError(body.details?.join("; ") || body.error || `Mediator service error (${res.status})`);
  }
  return res as unknown as T;
}

export async function hashFile(file: Blob): Promise<{ bytes: Uint8Array; hash: Hex }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { bytes, hash: keccak256(bytes) };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Hash locally, sign the hash with the wallet, upload to the mediator's evidence store. */
export async function uploadEvidence(p: {
  wallet: WalletClient;
  account: Address;
  escrowId: bigint;
  bytes: Uint8Array;
  name: string;
  mimeType: string;
  kind: "evidence" | "terms";
}): Promise<{ contentHash: Hex; uri: string }> {
  const contentHash = keccak256(p.bytes);
  const signature = await p.wallet.signMessage({
    account: p.account,
    message: uploadMessage({ chainId: config.chainId, escrow: config.escrow, escrowId: p.escrowId, contentHash, kind: p.kind }),
  });
  const res = await call<Response>("/evidence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      escrowId: p.escrowId.toString(),
      kind: p.kind,
      name: p.name,
      mimeType: p.mimeType || "application/octet-stream",
      contentBase64: toBase64(p.bytes),
      signature,
    }),
  });
  const out = (await res.json()) as { contentHash: Hex; uri: string };
  if (out.contentHash.toLowerCase() !== contentHash.toLowerCase()) throw new MediatorApiError("The service computed a different hash. Upload aborted.");
  return out;
}

// Read grants live in memory only (never persisted), and expire within the hour.
const grants = new Map<string, { expires: number; signature: Hex }>();

export async function openEvidence(p: { wallet: WalletClient; account: Address; escrowId: bigint; hash: Hex }): Promise<Blob> {
  const key = `${p.account}:${p.escrowId}`;
  let g = grants.get(key);
  const now = Math.floor(Date.now() / 1000);
  if (!g || g.expires - now < 60) {
    const expires = now + 30 * 60;
    const signature = await p.wallet.signMessage({
      account: p.account,
      message: readMessage({ chainId: config.chainId, escrow: config.escrow, escrowId: p.escrowId, expires }),
    });
    g = { expires, signature };
    grants.set(key, g);
  }
  const q = new URLSearchParams({ escrowId: p.escrowId.toString(), expires: String(g.expires), signature: g.signature });
  const res = await call<Response>(`/evidence/${p.hash}?${q}`);
  const blob = await res.blob();
  const check = keccak256(new Uint8Array(await blob.arrayBuffer()));
  if (check.toLowerCase() !== p.hash.toLowerCase()) throw new MediatorApiError("Evidence failed its integrity check: the file doesn't match its on-chain hash.");
  return blob;
}

export interface ReasoningDoc {
  schema: string;
  engine: { mode: "claude" | "rules"; model?: string; servedBy?: string };
  payeeAmount: string;
  decision: {
    payee_share_bps: number;
    confidence: "low" | "medium" | "high";
    summary: string;
    rationale: string;
    findings: { evidence_index: number; party: "payer" | "payee"; assessment: string }[];
    suspicious_instructions_detected: boolean;
  };
  evidence: { index: number; party: string; contentHash: string; status: string }[];
  termsVerified: boolean;
  decidedAt: string;
}

/** Fetch the mediator's rationale and verify it against the on-chain commitment. */
export async function fetchReasoning(hash: Hex): Promise<{ doc: ReasoningDoc; verified: boolean }> {
  const res = await call<Response>(`/reasoning/${hash}`);
  const text = await res.text();
  const verified = keccak256(toBytes(text)).toLowerCase() === hash.toLowerCase();
  return { doc: JSON.parse(text) as ReasoningDoc, verified };
}

export interface Health {
  ok: boolean;
  mode: string;
  mediator: Address;
  sessionKey: Address | null;
  sessionKeyCanPropose: boolean;
  worker: { running: boolean; lastTickAt?: string; lastTickError?: string };
}

export async function mediatorHealth(): Promise<Health> {
  const res = await call<Response>("/health");
  return (await res.json()) as Health;
}

export interface MediatorJob {
  escrowId: string;
  status: string;
  attempts: number;
  txHash?: Hex;
  reasoningHash?: Hex;
  lastError?: string;
  updatedAt: string;
}

export async function mediatorJobs(): Promise<MediatorJob[]> {
  const res = await call<Response>("/jobs");
  return ((await res.json()) as { jobs: MediatorJob[] }).jobs;
}
