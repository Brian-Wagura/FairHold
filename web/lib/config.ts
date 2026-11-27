import type { Address } from "viem";

// NEXT_PUBLIC_* values are inlined at build time, so each must be referenced literally.
export const config = {
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 44005),
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc-test.qday.info",
  explorerUrl: (process.env.NEXT_PUBLIC_EXPLORER_URL ?? "https://explorer-test.qday.info").replace(/\/$/, ""),
  escrow: (process.env.NEXT_PUBLIC_ESCROW_ADDRESS ?? "") as Address,
  token: (process.env.NEXT_PUBLIC_TOKEN_ADDRESS ?? "0x456569838f1d43009A91ebA4263147Afd7233483") as Address,
  mediatorApi: (process.env.NEXT_PUBLIC_MEDIATOR_URL ?? "http://localhost:8787").replace(/\/$/, ""),
  defaultMediator: (process.env.NEXT_PUBLIC_DEFAULT_MEDIATOR ?? "") as Address,
  deployBlock: BigInt(process.env.NEXT_PUBLIC_DEPLOY_BLOCK ?? "0"),
  tokenSymbol: "tUSD8",
  tokenDecimals: 6,
  faucetUrl: "https://faucet.qday.info",
};

export const isConfigured = /^0x[0-9a-fA-F]{40}$/.test(config.escrow);

export const txUrl = (hash: string) => `${config.explorerUrl}/tx/${hash}`;
export const addressUrl = (a: string) => `${config.explorerUrl}/address/${a}`;
