"use client";

import { useCallback, useState } from "react";
import { chainTimeOffsetMs, escrowContract, publicClient, readEscrow, type Escrow } from "@/lib/chain";
import { config } from "@/lib/config";
import { describePhase, actionNeeded, isOpen, roleOf } from "@/lib/escrow-view";
import { explainError, fmtAmount, fmtDate, short } from "@/lib/format";
import { IconChevronRight, IconClock, IconExternal, IconHandshake, IconInbox, IconLock, IconPlus, IconRefresh, IconScale, IconShield, IconSparkle } from "./icons";
import { Button, buttonClass, Countdown, EmptyState, Segmented, Notice, PageHeader, Skeleton, StatusBadge, cx, inputCls, useChainNow, usePoll } from "./ui";
import { useWallet } from "./wallet";
import { calloutClass, eyebrowClass, iconTileClass, itemTitleClass, sectionClass } from "@/lib/ui-classes";

type Row = { id: bigint; e: Escrow };
type Filter = "all" | "action" | "open" | "closed";

export function Dashboard({ go }: { go: (path: string) => void }) {
  const { address, connect, connecting, hasProvider, tokenBalance, gasBalance } = useWallet();
  const [rows, setRows] = useState<Row[]>();
  const [err, setErr] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [lookup, setLookup] = useState("");
  const [lookupErr, setLookupErr] = useState<string>();
  const now = BigInt(useChainNow(offset));

  const load = useCallback(async () => {
    if (!address) return;
    setRefreshing(true);
    try {
      const [ids, off] = await Promise.all([
        publicClient.readContract({ ...escrowContract, functionName: "escrowsOf", args: [address] }),
        chainTimeOffsetMs(),
      ]);
      const unique = [...new Set(ids.map(String))].map(BigInt).sort((a, b) => Number(b - a)).slice(0, 50);
      setRows(await Promise.all(unique.map(async (id) => ({ id, e: await readEscrow(id) }))));
      setOffset(off);
      setErr(undefined);
    } catch (x) {
      setErr(explainError(x));
    } finally {
      setRefreshing(false);
    }
  }, [address]);

  usePoll(load, 10_000);

  if (!address) return <Landing connect={connect} connecting={connecting} hasProvider={hasProvider} />;

  const withMeta = (rows ?? []).map((r) => ({ ...r, todo: actionNeeded(r.e, address, now), role: roleOf(r.e, address) }));
  const counts = {
    all: withMeta.length,
    action: withMeta.filter((r) => r.todo).length,
    open: withMeta.filter((r) => isOpen(r.e)).length,
    closed: withMeta.filter((r) => !isOpen(r.e)).length,
  };
  const visible = withMeta.filter((r) => (filter === "action" ? r.todo : filter === "open" ? isOpen(r.e) : filter === "closed" ? !isOpen(r.e) : true));
  const lockedAsPayer = withMeta.filter((r) => isOpen(r.e) && r.role === "payer").reduce((s, r) => s + r.e.amount, 0n);
  const incoming = withMeta.filter((r) => isOpen(r.e) && r.role === "payee").reduce((s, r) => s + r.e.amount, 0n);

  return (
    <div className="space-y-6">
      {(tokenBalance === 0n || gasBalance === 0n) && (
        <Notice
          tone="warn"
          title="You need test tokens to get started"
          action={<a className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors border border-amber-200 bg-amber-100 text-amber-800 hover:bg-amber-200/70 dark:border-amber-900/60 dark:bg-amber-900/30 dark:text-amber-300" href={config.faucetUrl} target="_blank" rel="noreferrer">Open faucet <IconExternal size={12} /></a>}
        >
          {gasBalance === 0n && "tQDAY pays for gas. "}
          {tokenBalance === 0n && "tUSD8 is what you lock in escrow. "}
          You can also use the <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/40">/faucet</code> command on the QDay Discord.
        </Notice>
      )}

      <PageHeader
        title="My escrows"
        description="Everything you're paying, receiving or mediating. Status is read live from the chain."
        actions={
          <>
            <Button variant="secondary" onClick={() => void load()} busy={refreshing && rows !== undefined} aria-label="Refresh escrows">
              <IconRefresh /> <span className="hidden sm:inline">Refresh</span>
            </Button>
            <Button onClick={() => go("/new")}><IconPlus /> New escrow</Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Needs your action" value={rows ? String(counts.action) : undefined} tone={counts.action > 0 ? "alert" : "default"} />
        <Stat label="Open escrows" value={rows ? String(counts.open) : undefined} />
        <Stat label="You've locked" value={rows ? `${fmtAmount(lockedAsPayer)}` : undefined} unit="tUSD8" />
        <Stat label="Coming to you" value={rows ? `${fmtAmount(incoming)}` : undefined} unit="tUSD8" />
      </div>

      {err && (
        <Notice tone="error" title="Couldn't load your escrows" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>
          {err}
        </Notice>
      )}

      <div className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-col gap-3 border-b border-gray-100 dark:border-gray-700 p-3 sm:flex-row sm:items-center sm:justify-between">
          <Segmented<Filter>
            label="Filter escrows"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", count: rows ? counts.all : undefined },
              { value: "action", label: "Needs action", count: rows ? counts.action : undefined },
              { value: "open", label: "Open", count: rows ? counts.open : undefined },
              { value: "closed", label: "Closed", count: rows ? counts.closed : undefined },
            ]}
          />
          <form
            className="flex gap-2"
            onSubmit={(x) => {
              x.preventDefault();
              if (/^\d+$/.test(lookup.trim()) && lookup.trim() !== "0") go(`/escrow/${lookup.trim()}`);
              else setLookupErr("Enter an escrow number, e.g. 12");
            }}
          >
            <label htmlFor="escrow-lookup" className="sr-only">Open an escrow by number</label>
            <input
              id="escrow-lookup"
              className={`${inputCls} w-full sm:w-40`}
              inputMode="numeric"
              placeholder="Escrow #"
              value={lookup}
              aria-invalid={lookupErr ? true : undefined}
              aria-describedby={lookupErr ? "escrow-lookup-err" : undefined}
              onChange={(x) => { setLookup(x.target.value); setLookupErr(undefined); }}
            />
            <Button variant="secondary" type="submit">Open</Button>
          </form>
        </div>
        {lookupErr && <p id="escrow-lookup-err" className="border-b border-gray-100 dark:border-gray-700 px-4 py-2 text-xs font-medium text-red-600 dark:text-red-400">{lookupErr}</p>}

        {rows === undefined && !err ? (
          <ul aria-busy="true" aria-label="Loading escrows" className="divide-y divide-gray-100 dark:divide-gray-700">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-4 px-5 py-4">
                <Skeleton className="h-9 w-9 rounded-full" />
                <div className="flex-1 space-y-2"><Skeleton className="h-4 w-48" /><Skeleton className="h-3 w-32" /></div>
                <Skeleton className="h-6 w-24 rounded-full" />
              </li>
            ))}
          </ul>
        ) : rows && rows.length === 0 ? (
          <EmptyState
            icon={<IconInbox size={22} />}
            title="No escrows yet"
            body="Create one to protect a payment, or share your address with someone who's paying you."
            action={<Button onClick={() => go("/new")}><IconPlus /> Create your first escrow</Button>}
          />
        ) : visible.length === 0 ? (
          <EmptyState title={filter === "action" ? "You're all caught up" : "Nothing here"} body={filter === "action" ? "No escrow needs anything from you right now." : "No escrows match this filter."} />
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-700">
            {visible.map(({ id, e, todo, role }) => {
              const counter = role === "payer" ? e.payee : e.payer;
              const phase = describePhase(e, now);
              const verb = role === "payer" ? "Paying" : role === "payee" ? "Receiving" : "Mediating";
              return (
                <li key={id.toString()}>
                  <a href={`#/escrow/${id}`} className="group grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-2 px-4 py-4 hover:bg-gray-50 dark:hover:bg-gray-700/40 sm:px-5">
                    <span className={cx("flex h-10 w-10 items-center justify-center rounded-full text-xs font-bold tabular-nums", role === "payer" ? "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200" : role === "payee" ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900" : "border border-gray-200 text-gray-600 dark:border-gray-600 dark:text-gray-300")}>
                      #{id.toString()}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-gray-900 dark:text-white">
                        {verb} <span className="tabular-nums">{fmtAmount(e.amount)}</span> tUSD8
                      </span>
                      <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                        {role === "payer" ? "to" : "from"} <span className="font-mono">{short(counter)}</span> · {phase.deadline && isOpen(e) ? <span className="inline-flex items-center gap-1"><IconClock size={12} /> {phase.deadlineLabel} in <Countdown deadline={phase.deadline} offsetMs={offset} done="now" /></span> : fmtDate(e.settledAt > 0n ? e.settledAt : e.createdAt)}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="hidden flex-col items-end gap-1 sm:flex">
                        <StatusBadge status={e.status} />
                        {todo && <span className="text-xs font-semibold text-red-600 dark:text-red-400">{todo} →</span>}
                      </span>
                      <IconChevronRight className="text-gray-500 dark:text-gray-400 group-hover:text-foreground" />
                    </span>
                    <span className="col-span-3 flex flex-wrap items-center gap-2 sm:hidden">
                      <StatusBadge status={e.status} />
                      {todo && <span className="text-xs font-semibold text-red-600 dark:text-red-400">{todo} →</span>}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, unit, tone = "default" }: { label: string; value?: string; unit?: string; tone?: "default" | "alert" }) {
  return (
    <div className={cx("rounded-xl border border-gray-100 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 p-4", tone === "alert" && "border-red-200 dark:border-red-900/60")}>
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
      {value === undefined ? (
        <Skeleton className="mt-2 h-7 w-20" />
      ) : (
        <p className={cx("mt-1 text-2xl font-semibold tabular-nums tracking-tight", tone === "alert" && "text-red-600 dark:text-red-400")}>
          {value}
          {unit && <span className="ml-1 text-xs font-medium text-gray-500 dark:text-gray-400">{unit}</span>}
        </p>
      )}
    </div>
  );
}

function Landing({ connect, connecting, hasProvider }: { connect: () => void; connecting: boolean; hasProvider: boolean }) {
  return (
    <div className="space-y-12 sm:space-y-16">
      <section className={cx(sectionClass, "p-6 sm:p-10 lg:p-12")}>
        <div className="grid items-center gap-10 lg:grid-cols-[1.2fr_1fr]">
          <div className="min-w-0">
            <p className={eyebrowClass}>Stablecoin escrow on QDay Aevum</p>
            <h1 className="mt-4 break-words text-3xl font-bold leading-[1.1] tracking-tight text-gray-900 sm:text-5xl dark:text-white">Get paid fairly, even when things go wrong.</h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-gray-600 sm:text-lg dark:text-gray-300">
              FairHold locks tUSD8 until the job is done. If there&apos;s a dispute, an AI mediator reviews the evidence and proposes a split. It can never move your money, and you can always say no.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button size="lg" className="w-full sm:w-auto" onClick={connect} busy={connecting} busyLabel="Connecting…" disabled={!hasProvider}>
                Connect wallet to start
              </Button>
              <a
                href="#how"
                onClick={(e) => { e.preventDefault(); document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }); }}
                className={cx(buttonClass("secondary", "lg"), "w-full sm:w-auto")}
              >
                How it works
              </a>
            </div>
            {!hasProvider && <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">No browser wallet detected. Install MetaMask, Rabby or another EVM wallet to continue.</p>}
          </div>
          <HeroCard />
        </div>
      </section>

      <section id="how" aria-labelledby="how-title" className="scroll-mt-24">
        <h2 id="how-title" className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">How it works</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Four steps, each one a transaction you sign. No accounts, no custody.</p>
        <ol className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [<IconLock key="i" />, "Lock", "The payer locks tUSD8 with one permit signature. Only a hash of the agreement goes on-chain; the text stays private."],
            [<IconHandshake key="i" />, "Accept", "The payee accepts the exact terms. If they don't accept in time, the payer gets a full refund."],
            [<IconScale key="i" />, "Resolve", "Agree on a split at any time, or open a dispute. Evidence is hashed in your browser and committed on-chain."],
            [<IconSparkle key="i" />, "Mediate", "An AI mediator proposes one bounded split. Accept it, reject it, or let the deadline decide."],
          ].map(([icon, t, d], i) => (
            <li key={String(t)} className={cx(sectionClass, "p-5")}>
              <div className="flex items-center gap-3">
                <span className={iconTileClass}>{icon}</span>
                <span className={eyebrowClass}>Step {i + 1}</span>
              </div>
              <p className={cx(itemTitleClass, "mt-4")}>{t}</p>
              <p className="mt-1 text-sm leading-relaxed text-gray-500 dark:text-gray-400">{d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="trust-title">
        <h2 id="trust-title" className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">Why you can trust it</h2>
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          {[
            ["The AI never holds funds", "The mediator's key can only submit a proposal. It can't withdraw, settle, or exceed the escrowed amount, and it expires."],
            ["No single point of failure", "Every stage has a deadline anyone can trigger, so your money never waits on a server or an AI being online."],
            ["Reasoning you can verify", "The mediator's rationale is hashed and committed on-chain with its proposal, so it can't be quietly edited later."],
          ].map(([t, d]) => (
            <div key={t} className={cx(calloutClass, "flex gap-3 p-5")}>
              <span className={iconTileClass}><IconShield size={16} /></span>
              <div className="min-w-0">
                <p className={itemTitleClass}>{t}</p>
                <p className="mt-1 text-sm leading-relaxed text-gray-500 dark:text-gray-400">{d}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/** Decorative preview of an escrow so first-time visitors see what they'll get. */
function HeroCard() {
  return (
    <div aria-hidden className={cx(calloutClass, "hidden p-5 lg:block")}>
      <div className="flex items-center justify-between">
        <span className={itemTitleClass}>Escrow #42</span>
        <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">Proposal ready</span>
      </div>
      <p className="mt-4 text-3xl font-bold tabular-nums tracking-tight text-gray-900 dark:text-white">
        1,200.00 <span className="text-sm font-medium text-gray-500 dark:text-gray-400">tUSD8</span>
      </p>
      <div className="mt-5 flex h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div className="w-[70%] bg-gray-900 dark:bg-gray-100" />
      </div>
      <div className="mt-2 flex justify-between text-xs text-gray-500 dark:text-gray-400"><span>Payee 70%</span><span>Payer 30%</span></div>
      <div className="mt-5 rounded-lg border border-gray-100 bg-white p-3 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
        <p className="flex items-center gap-1.5 text-xs font-medium text-green-600 dark:text-green-400"><IconShield size={14} /> Rationale matches on-chain hash</p>
        <p className="mt-1.5">Two of three deliverables were shipped on time; the third is blocked on the client&apos;s credentials.</p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-center text-sm font-medium">
        <span className="rounded-lg bg-gray-900 py-2 text-white dark:bg-gray-100 dark:text-gray-900">Accept</span>
        <span className="rounded-lg border border-gray-300 bg-white py-2 text-gray-700 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200">Reject</span>
      </div>
    </div>
  );
}
