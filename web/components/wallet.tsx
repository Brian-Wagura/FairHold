"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Address, WalletClient } from "viem";
import { aevum, connectWallet, ensureChain, injectedProvider, publicClient, tokenContract } from "@/lib/chain";
import { explainError } from "@/lib/format";
import { usePoll } from "./ui";

interface WalletState {
  /** A browser wallet (EIP-1193 provider) is installed. */
  hasProvider: boolean;
  address?: Address;
  wallet?: WalletClient;
  wrongChain: boolean;
  connecting: boolean;
  error?: string;
  tokenBalance?: bigint;
  gasBalance?: bigint;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
  refreshBalances: () => Promise<void>;
}

const Ctx = createContext<WalletState | null>(null);

export function useWallet() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<Address>();
  const [wallet, setWallet] = useState<WalletClient>();
  const [chainId, setChainId] = useState<number>();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();
  const [tokenBalance, setTokenBalance] = useState<bigint>();
  const [gasBalance, setGasBalance] = useState<bigint>();

  const refreshBalances = useCallback(async () => {
    if (!address) return;
    try {
      const [t, g] = await Promise.all([
        publicClient.readContract({ ...tokenContract, functionName: "balanceOf", args: [address] }),
        publicClient.getBalance({ address }),
      ]);
      setTokenBalance(t);
      setGasBalance(g);
    } catch {
      /* RPC hiccup: keep last values */
    }
  }, [address]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(undefined);
    try {
      const r = await connectWallet();
      setWallet(r.wallet);
      setAddress(r.address);
      setChainId(await r.wallet.getChainId());
      localStorage.setItem("fairhold:autoconnect", "1");
    } catch (e) {
      setError(explainError(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(undefined);
    setWallet(undefined);
    localStorage.removeItem("fairhold:autoconnect");
  }, []);

  const switchChain = useCallback(async () => {
    if (!wallet) return;
    try {
      await ensureChain(wallet);
      setChainId(await wallet.getChainId());
    } catch (e) {
      setError(explainError(e));
    }
  }, [wallet]);

  // Reconnect silently if the user connected before and the wallet still authorizes us.
  useEffect(() => {
    const p = injectedProvider();
    if (!p || localStorage.getItem("fairhold:autoconnect") !== "1") return;
    p.request({ method: "eth_accounts" })
      .then((accs) => {
        if ((accs as string[]).length) void connect();
      })
      .catch(() => {});
  }, [connect]);

  useEffect(() => {
    const p = injectedProvider();
    if (!p?.on) return;
    const onAccounts = (accs: string[]) => setAddress((accs[0] as Address | undefined) ?? undefined);
    const onChain = (id: string) => setChainId(Number(id));
    p.on("accountsChanged", onAccounts as never);
    p.on("chainChanged", onChain as never);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts as never);
      p.removeListener?.("chainChanged", onChain as never);
    };
  }, []);

  usePoll(refreshBalances, 15_000);

  const hasProvider = useSyncExternalStore(
    () => () => {},
    () => Boolean(injectedProvider()),
    () => true, // assume present during prerender to avoid a flash of the install hint
  );

  const value = useMemo<WalletState>(
    () => ({
      hasProvider,
      address,
      wallet,
      wrongChain: Boolean(address && chainId !== undefined && chainId !== aevum.id),
      connecting,
      error,
      tokenBalance,
      gasBalance,
      connect,
      disconnect,
      switchChain,
      refreshBalances,
    }),
    [hasProvider, address, wallet, chainId, connecting, error, tokenBalance, gasBalance, connect, disconnect, switchChain, refreshBalances],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
