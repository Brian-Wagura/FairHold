"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { addressUrl, config, isConfigured } from "@/lib/config";
import { fmtAmount, short } from "@/lib/format";
import { CreateEscrow } from "./CreateEscrow";
import { Dashboard } from "./Dashboard";
import { EscrowDetail } from "./EscrowDetail";
import { IconExternal, IconScale, IconWallet } from "./icons";
import { MediatorConsole } from "./MediatorConsole";
import { ThemeToggle } from "./theme";
import { activePillClass, inactivePillClass, navLinkClass, pillBaseClass, popoverClass } from "@/lib/ui-classes";
import { TxProvider, useTx } from "./tx";
import { Button, ConfirmProvider, CopyButton, Notice, Spinner, cx } from "./ui";
import { WalletProvider, useWallet } from "./wallet";

// Hash routing keeps the app a static, fully client-side bundle with shareable links.
function useHashRoute() {
  const [path, setPath] = useState("/");
  useEffect(() => {
    const read = () => setPath(window.location.hash.replace(/^#/, "") || "/");
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const go = useCallback((p: string) => {
    window.location.hash = p;
    window.scrollTo({ top: 0 });
  }, []);
  return { path, go };
}

export function App() {
  return (
    <WalletProvider>
      <TxProvider>
        <ConfirmProvider>
          <Shell />
        </ConfirmProvider>
      </TxProvider>
    </WalletProvider>
  );
}

const NAV = [
  ["/", "My escrows"],
  ["/new", "New escrow"],
  ["/mediator", "Mediator"],
] as const;

const networkName = config.chainId === 44005 ? "Aevum testnet" : `Chain ${config.chainId}`;

function Shell() {
  const { path, go } = useHashRoute();
  const w = useWallet();
  const escrowMatch = path.match(/^\/escrow\/(\d+)$/);
  const mainRef = useRef<HTMLElement>(null);

  // Move focus to the page on route changes so keyboard and screen-reader users land in the content.
  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, [path]);

  const active = (p: string) => (p === "/" ? path === "/" || !!escrowMatch : path === p);

  return (
    <div className="flex min-h-full flex-col">
      <a
        href="#main"
        onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-gray-900 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:ring-2 focus:ring-gray-400 dark:focus:bg-gray-100 dark:focus:text-gray-900"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-50 w-full border-b border-gray-100 bg-white/95 dark:border-gray-700 dark:bg-gray-900/95">
        <div className="container mx-auto flex h-16 max-w-page items-center gap-3 px-4 sm:gap-8">
          <a href="#/" className="flex shrink-0 items-center gap-2 rounded-lg text-gray-900 dark:text-white" aria-label="FairHold home">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900">
              <IconScale size={17} />
            </span>
            <span className="text-lg font-semibold tracking-tight sm:text-xl">FairHold</span>
          </a>
          <nav aria-label="Main" className="hidden items-center gap-6 md:flex">
            {NAV.map(([p, l]) => (
              <a
                key={p}
                href={`#${p}`}
                aria-current={active(p) ? "page" : undefined}
                className={active(p) ? "text-sm font-semibold text-gray-900 dark:text-white" : navLinkClass}
              >
                {l}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            <NetworkPill />
            <ThemeToggle />
            <WalletControl />
          </div>
        </div>
        <nav aria-label="Main" className="container mx-auto flex max-w-page gap-2 overflow-x-auto px-4 pb-3 md:hidden">
          {NAV.map(([p, l]) => (
            <a key={p} href={`#${p}`} aria-current={active(p) ? "page" : undefined} className={cx(pillBaseClass, "whitespace-nowrap", active(p) ? activePillClass : inactivePillClass)}>
              {l}
            </a>
          ))}
        </nav>
      </header>

      <main id="main" ref={mainRef} tabIndex={-1} className="container mx-auto w-full max-w-page flex-1 px-4 py-8 outline-none sm:py-10">
        <div className="space-y-3 empty:hidden [&:not(:empty)]:mb-6">
          {!isConfigured && (
            <Notice tone="error" title="App not configured">
              NEXT_PUBLIC_ESCROW_ADDRESS is not set. Copy <code>web/.env.example</code> to <code>web/.env.local</code> and add the deployed contract address.
            </Notice>
          )}
          {w.error && <Notice tone="error" title="Wallet problem">{w.error}</Notice>}
          {w.wrongChain && (
            <Notice tone="warn" title="Wrong network" action={<Button size="sm" onClick={w.switchChain}>Switch network</Button>}>
              Your wallet is on another network. Switch to {config.chainId === 44005 ? "QDay Aevum Testnet (44005)" : `chain ${config.chainId}`} to send transactions.
            </Notice>
          )}
        </div>

        {escrowMatch ? (
          <EscrowDetail key={escrowMatch[1]} id={BigInt(escrowMatch[1]!)} go={go} />
        ) : path === "/new" ? (
          w.address ? <CreateEscrow onCreated={(id) => go(`/escrow/${id}`)} /> : <ConnectPrompt what="create an escrow" />
        ) : path === "/mediator" ? (
          <MediatorConsole />
        ) : (
          <Dashboard go={go} />
        )}
      </main>

      <footer className="border-t border-gray-100 bg-gray-50/80 dark:border-gray-700 dark:bg-gray-900/50">
        <div className="container mx-auto flex max-w-page flex-col gap-2 px-4 py-8 text-xs text-gray-500 sm:flex-row sm:items-center sm:justify-between dark:text-gray-400">
          <p>FairHold · QDay {networkName} (chain {config.chainId}) · test tokens only, no real value</p>
          <p className="flex items-center gap-1">
            Contract{" "}
            {isConfigured ? (
              <a className="inline-flex items-center gap-1 font-mono font-medium text-gray-900 underline-offset-4 hover:underline dark:text-white" href={addressUrl(config.escrow)} target="_blank" rel="noreferrer">
                {short(config.escrow)} <IconExternal size={12} />
              </a>
            ) : (
              "not configured"
            )}
          </p>
        </div>
      </footer>
    </div>
  );
}

function NetworkPill() {
  const w = useWallet();
  if (w.wrongChain) {
    return (
      <button type="button" onClick={w.switchChain} className="hidden items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors sm:inline-flex border border-amber-200 bg-amber-100 text-amber-800 hover:bg-amber-200/70 dark:border-amber-900/60 dark:bg-amber-900/30 dark:text-amber-300">
        <span className="h-2 w-2 rounded-full bg-amber-500" aria-hidden /> Wrong network
      </button>
    );
  }
  return (
    <span className="hidden items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 border sm:inline-flex">
      <span className="h-2 w-2 rounded-full bg-green-500" aria-hidden /> {networkName}
    </span>
  );
}

function WalletControl() {
  const w = useWallet();
  const { pending } = useTx();
  const ref = useRef<HTMLDetailsElement>(null);

  if (!w.address) {
    return (
      <Button onClick={w.connect} busy={w.connecting} busyLabel="Connecting…">
        <IconWallet /> <span>Connect<span className="hidden sm:inline"> wallet</span></span>
      </Button>
    );
  }
  return (
    <details ref={ref} className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 [&::-webkit-details-marker]:hidden">
        {pending > 0 ? <Spinner className="text-gray-900 dark:text-white" /> : <span className={cx("h-2 w-2 rounded-full", w.wrongChain ? "bg-amber-500" : "bg-green-500")} aria-hidden />}
        <span className="font-mono">{short(w.address)}</span>
        {w.tokenBalance !== undefined && <span className="hidden border-l border-gray-100 dark:border-gray-700 pl-2 tabular-nums text-gray-500 dark:text-gray-400 lg:inline">{fmtAmount(w.tokenBalance)} tUSD8</span>}
        <span className="sr-only">{pending > 0 ? `${pending} transaction pending. ` : ""}Open wallet menu</span>
      </summary>
      <div className={cx(popoverClass, "absolute right-0 z-50 mt-2 w-72 p-4 text-gray-900 dark:text-white")}>
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Connected account</p>
        <p className="mt-1 flex items-center gap-1 font-mono text-sm">
          {short(w.address)} <CopyButton value={w.address} label="Copy address" />
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-lg bg-gray-50 dark:bg-gray-900/50 p-2.5">
            <dt className="text-xs text-gray-500 dark:text-gray-400">tUSD8</dt>
            <dd className="font-semibold tabular-nums">{w.tokenBalance !== undefined ? fmtAmount(w.tokenBalance) : "…"}</dd>
          </div>
          <div className="rounded-lg bg-gray-50 dark:bg-gray-900/50 p-2.5">
            <dt className="text-xs text-gray-500 dark:text-gray-400">tQDAY (gas)</dt>
            <dd className="font-semibold tabular-nums">{w.gasBalance !== undefined ? (Number(w.gasBalance) / 1e18).toFixed(3) : "…"}</dd>
          </div>
        </dl>
        {pending > 0 && <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{pending} transaction{pending > 1 ? "s" : ""} in progress…</p>}
        <div className="mt-4 flex flex-col gap-2">
          <a href={config.faucetUrl} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600">
            Get test tokens <IconExternal size={12} />
          </a>
          {w.wrongChain && <Button size="sm" onClick={w.switchChain}>Switch to {networkName}</Button>}
          <Button size="sm" variant="ghost" onClick={() => { if (ref.current) ref.current.open = false; w.disconnect(); }}>Disconnect</Button>
        </div>
      </div>
    </details>
  );
}

function ConnectPrompt({ what }: { what: string }) {
  const w = useWallet();
  return (
    <div className="mx-auto max-w-md p-8 text-center rounded-xl border border-gray-100 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500"><IconWallet size={22} /></div>
      <h1 className="mt-4 text-lg font-semibold">Connect your wallet to {what}</h1>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">FairHold never takes custody of your keys. Every action is a transaction you review and sign.</p>
      <Button className="mt-5" onClick={w.connect} busy={w.connecting} busyLabel="Connecting…" disabled={!w.hasProvider}>Connect wallet</Button>
      {!w.hasProvider && <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">No browser wallet detected. Install MetaMask, Rabby or another EVM wallet, then reload.</p>}
    </div>
  );
}
