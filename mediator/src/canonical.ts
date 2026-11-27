import { keccak256, toBytes, type Hex } from "viem";

/** Deterministic JSON: object keys sorted recursively, bigint rendered as decimal strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

/** Content-addressed commitment for a JSON document. */
export function hashJson(value: unknown): { json: string; hash: Hex } {
  const json = canonicalJson(value);
  return { json, hash: keccak256(toBytes(json)) };
}

export function hashBytes(bytes: Uint8Array): Hex {
  return keccak256(bytes);
}

/** payee amount = floor(amount * bps / 10_000), clamped to [0, amount]. Mirrors the contract. */
export function bpsOf(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps)) throw new Error("bps must be an integer");
  const clamped = BigInt(Math.min(10_000, Math.max(0, bps)));
  const v = (amount * clamped) / 10_000n;
  return v > amount ? amount : v;
}
