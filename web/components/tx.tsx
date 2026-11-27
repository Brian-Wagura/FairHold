"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Hash, TransactionReceipt } from "viem";
import { waitForTx } from "@/lib/chain";
import { explainError } from "@/lib/format";
import { IconAlert, IconCheck, IconX } from "./icons";
import { Spinner, TxLink, cx } from "./ui";

type Phase = "wallet" | "pending" | "confirmed" | "failed";
interface TxEntry {
  key: number;
  label: string;
  phase: Phase;
  hash?: Hash;
  error?: string;
  startedAt: number;
}

interface TxApi {
  /** Runs a wallet action and tracks it until the receipt confirms. Returns null on failure. */
  run: (label: string, send: () => Promise<Hash>) => Promise<TransactionReceipt | null>;
  /** Number of transactions waiting for a signature or a confirmation. */
  pending: number;
}

const Ctx = createContext<TxApi | null>(null);
export function useTx() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTx outside TxProvider");
  return v;
}

let seq = 0;

export function TxProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<TxEntry[]>([]);
  const update = (key: number, patch: Partial<TxEntry>) => setEntries((list) => list.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  const dismiss = (key: number) => setEntries((list) => list.filter((e) => e.key !== key));

  const run = useCallback<TxApi["run"]>(async (label, send) => {
    const key = ++seq;
    setEntries((l) => [...l.slice(-3), { key, label, phase: "wallet", startedAt: Date.now() }]);
    try {
      const hash = await send();
      update(key, { phase: "pending", hash, startedAt: Date.now() });
      const receipt = await waitForTx(hash);
      update(key, { phase: "confirmed" });
      setTimeout(() => dismiss(key), 10_000);
      return receipt;
    } catch (e) {
      update(key, { phase: "failed", error: explainError(e) });
      return null;
    }
  }, []);

  const pending = entries.filter((e) => e.phase === "wallet" || e.phase === "pending").length;

  return (
    <Ctx.Provider value={{ run, pending }}>
      {children}
      <div className="pointer-events-none fixed inset-x-3 bottom-3 z-50 flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-[24rem]">
        {entries.map((e) => (
          <Toast key={e.key} entry={e} onDismiss={() => dismiss(e.key)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

const STEPS: { phase: Phase; label: string }[] = [
  { phase: "wallet", label: "Sign" },
  { phase: "pending", label: "Confirming" },
  { phase: "confirmed", label: "Done" },
];

function Toast({ entry: e, onDismiss }: { entry: TxEntry; onDismiss: () => void }) {
  const [now, setNow] = useState(e.startedAt);
  useEffect(() => {
    if (e.phase !== "pending" && e.phase !== "wallet") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [e.phase]);
  const elapsed = Math.max(0, Math.round((now - e.startedAt) / 1000));
  const stepIdx = e.phase === "failed" ? -1 : STEPS.findIndex((s) => s.phase === e.phase);
  const failed = e.phase === "failed";

  return (
    <div
      role={failed ? "alert" : "status"}
      aria-live={failed ? "assertive" : "polite"}
      className={cx(
        "pointer-events-auto overflow-hidden rounded-lg border bg-white text-gray-900 dark:bg-gray-800 dark:text-white shadow-lg",
        failed ? "border-red-200 dark:border-red-900/60" : "border-gray-200 dark:border-gray-700",
      )}
    >
      <div className="flex items-start gap-3 p-4">
        <span
          className={cx(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            failed ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" : e.phase === "confirmed" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200",
          )}
          aria-hidden
        >
          {failed ? <IconAlert /> : e.phase === "confirmed" ? <IconCheck /> : <Spinner />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900 dark:text-white">{e.label}</p>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            {e.phase === "wallet" && "Check your wallet and approve the request."}
            {e.phase === "pending" && <>Submitted. Waiting for Aevum to confirm… <span className="tabular-nums">{elapsed}s</span></>}
            {e.phase === "confirmed" && "Confirmed on-chain. The page is up to date."}
            {failed && <span className="text-red-600 dark:text-red-400">{e.error}</span>}
          </p>
          {e.hash && <div className="mt-1.5"><TxLink hash={e.hash} label="View transaction" /></div>}
        </div>
        {(e.phase === "confirmed" || failed) && (
          <button type="button" onClick={onDismiss} className="-m-1 rounded-md p-1 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-foreground" aria-label="Dismiss notification">
            <IconX />
          </button>
        )}
      </div>
      {!failed && (
        <ol className="flex border-t border-gray-100 dark:border-gray-700 text-[11px] font-medium" aria-label="Transaction progress">
          {STEPS.map((s, i) => (
            <li
              key={s.phase}
              aria-current={i === stepIdx ? "step" : undefined}
              className={cx(
                "flex-1 py-1.5 text-center",
                i < stepIdx || e.phase === "confirmed" ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900" : i === stepIdx ? "bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white" : "text-gray-400 dark:text-gray-500",
              )}
            >
              {i + 1}. {s.label}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
