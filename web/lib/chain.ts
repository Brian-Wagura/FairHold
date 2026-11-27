"use client";

import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  erc20Abi,
  http,
  type Address,
  type EIP1193Provider,
  type Hash,
  type TransactionReceipt,
  TransactionReceiptNotFoundError,
  type WalletClient,
} from "viem";
import { mediatedEscrowAbi } from "./abi";
import { config } from "./config";

export const aevum = defineChain({
  id: config.chainId,
  name: config.chainId === 44005 ? "QDay Aevum Testnet" : `Local chain ${config.chainId}`,
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: config.explorerUrl } },
});

// Reads always go through our RPC, so they work before (and without) a wallet.
export const publicClient = createPublicClient({
  chain: aevum,
  transport: http(config.rpcUrl, { retryCount: 3, retryDelay: 400 }),
});

export const escrowContract = { address: config.escrow, abi: mediatedEscrowAbi } as const;
export const tokenContract = { address: config.token, abi: erc20Abi } as const;

export const Status = {
  None: 0,
  AwaitingPayee: 1,
  Active: 2,
  Disputed: 3,
  Proposed: 4,
  Settled: 5,
  Cancelled: 6,
} as const;

export const Resolution = [
  "None",
  "Mutual agreement",
  "Proposal accepted by both",
  "Proposal unchallenged",
  "Proposal rejected → fallback split",
  "Mediator timeout → fallback split",
  "No dispute → undisputed split",
  "Cancelled by payer",
  "Expired: payee never accepted",
] as const;

export type Escrow = Awaited<ReturnType<typeof readEscrow>>;

export function readEscrow(id: bigint) {
  return publicClient.readContract({ ...escrowContract, functionName: "getEscrow", args: [id] });
}

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export function injectedProvider(): EIP1193Provider | undefined {
  return typeof window !== "undefined" ? window.ethereum : undefined;
}

export async function connectWallet(): Promise<{ wallet: WalletClient; address: Address }> {
  const provider = injectedProvider();
  if (!provider) throw new Error("No browser wallet found. Install MetaMask, Rabby or another EVM wallet.");
  const wallet = createWalletClient({ chain: aevum, transport: custom(provider) });
  const [address] = await wallet.requestAddresses();
  if (!address) throw new Error("The wallet did not share an account.");
  await ensureChain(wallet);
  return { wallet, address };
}

export async function ensureChain(wallet: WalletClient): Promise<void> {
  const current = await wallet.getChainId();
  if (current === aevum.id) return;
  try {
    await wallet.switchChain({ id: aevum.id });
  } catch {
    await wallet.addChain({ chain: aevum });
    await wallet.switchChain({ id: aevum.id });
  }
}

/** Current chain time, so countdowns match what the contract enforces. */
export async function chainTimeOffsetMs(): Promise<number> {
  const block = await publicClient.getBlock({ blockTag: "latest" });
  return Number(block.timestamp) * 1000 - Date.now();
}

/** The transaction was mined and reverted: it definitely had no effect. */
export class TxRevertedError extends Error {
  constructor(readonly hash: Hash) {
    super("The transaction was mined but reverted.");
  }
}

export async function waitForTx(hash: Hash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 1_500 });
  if (receipt.status !== "success") throw new TxRevertedError(hash);
  return receipt;
}

/** One-shot status check for a transaction whose outcome is not yet known. */
export async function checkTx(hash: Hash): Promise<{ status: "confirmed"; receipt: TransactionReceipt } | { status: "reverted" } | { status: "pending" }> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    return receipt.status === "success" ? { status: "confirmed", receipt } : { status: "reverted" };
  } catch (e) {
    if (e instanceof TransactionReceiptNotFoundError) return { status: "pending" };
    throw e;
  }
}

/**
 * Event history for one escrow. Aevum's RPC rejects eth_getLogs ranges over 1,000 blocks,
 * so we walk backwards in chunks (bounded) from the latest block.
 */
export async function escrowHistory(id: bigint, maxChunks = 40) {
  const latest = await publicClient.getBlockNumber();
  const chunk = 999n;
  const out: { event: string; tx: Hash; block: bigint; args: Record<string, unknown> }[] = [];
  let to = latest;
  for (let i = 0; i < maxChunks && to >= config.deployBlock; i++) {
    const from = to > chunk + config.deployBlock ? to - chunk : config.deployBlock;
    const logs = await publicClient.getContractEvents({
      ...escrowContract,
      fromBlock: from,
      toBlock: to,
      args: { id } as never,
    });
    for (const l of logs) {
      const args = (l.args ?? {}) as Record<string, unknown>;
      if (args.id !== undefined && args.id !== id) continue;
      out.push({ event: l.eventName, tx: l.transactionHash, block: l.blockNumber, args });
    }
    if (out.some((e) => e.event === "EscrowCreated")) break;
    if (from === config.deployBlock) break;
    to = from - 1n;
  }
  return out.sort((a, b) => Number(a.block - b.block));
}
