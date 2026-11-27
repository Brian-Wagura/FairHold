import { createPublicClient, createWalletClient, defineChain, http, type Address, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mediatedEscrowAbi } from "./abi.ts";
import type { Config } from "./config.ts";

/** Mirrors `MediatedEscrow.Status`. Keep in sync with the Solidity enum. */
export const Status = {
  None: 0,
  AwaitingPayee: 1,
  Active: 2,
  Disputed: 3,
  Proposed: 4,
  Settled: 5,
  Cancelled: 6,
} as const;

export function aevumChain(cfg: Pick<Config, "CHAIN_ID" | "RPC_URL" | "EXPLORER_URL">): Chain {
  return defineChain({
    id: cfg.CHAIN_ID,
    name: cfg.CHAIN_ID === 44005 ? "QDay Aevum Testnet" : `Chain ${cfg.CHAIN_ID}`,
    nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
    rpcUrls: { default: { http: [cfg.RPC_URL] } },
    blockExplorers: { default: { name: "Aevum Explorer", url: cfg.EXPLORER_URL } },
  });
}

export function makeClients(cfg: Config) {
  const chain = aevumChain(cfg);
  // Aevum RPC is HTTPS-only (no websockets): every read is polled.
  const transport = http(cfg.RPC_URL, { retryCount: 3, retryDelay: 500, timeout: 20_000 });
  const publicClient = createPublicClient({ chain, transport });
  const account = cfg.SESSION_KEY_PRIVATE_KEY ? privateKeyToAccount(cfg.SESSION_KEY_PRIVATE_KEY) : undefined;
  const walletClient = account ? createWalletClient({ chain, transport, account }) : undefined;
  return { chain, publicClient, walletClient, account };
}

export type PublicClient = ReturnType<typeof makeClients>["publicClient"];
export type WalletClient = NonNullable<ReturnType<typeof makeClients>["walletClient"]>;

export function escrowContract(address: Address) {
  return { address, abi: mediatedEscrowAbi } as const;
}

export async function readEscrow(client: PublicClient, escrow: Address, id: bigint) {
  return client.readContract({ ...escrowContract(escrow), functionName: "getEscrow", args: [id] });
}

export type EscrowView = Awaited<ReturnType<typeof readEscrow>>;

export async function chainNow(client: PublicClient): Promise<bigint> {
  // Deadlines are enforced against block time, so decide against block time too.
  const block = await client.getBlock({ blockTag: "latest" });
  return block.timestamp;
}
