"use client";

import { useCallback, useEffect, useState, type DragEvent } from "react";
import { formatUnits, type Abi, type Address, type Hash, type Hex } from "viem";
import { Resolution, Status, chainTimeOffsetMs, escrowContract, escrowHistory, publicClient, readEscrow, type Escrow } from "@/lib/chain";
import { config } from "@/lib/config";
import { ROLE_LABEL, describePhase, finalizeReady, roleOf, type Role } from "@/lib/escrow-view";
import { explainError, fmtAmount, fmtDate, parseAmount, pct, short } from "@/lib/format";
import { fetchReasoning, hashFile, openEvidence, showEvidence, uploadEvidence, type ReasoningDoc } from "@/lib/mediator-api";
import { IconAlert, IconArrowLeft, IconCheck, IconClock, IconFile, IconHandshake, IconRefresh, IconShield, IconSparkle, IconUpload, IconX } from "./icons";
import { useTx } from "./tx";
import {
  AddressLink,
  Amount,
  Badge,
  Button,
  Card,
  CopyButton,
  Countdown,
  EmptyState,
  Field,
  Notice,
  Skeleton,
  SplitBar,
  StatusBadge,
  TimeBar,
  TxLink,
  cx,
  inputCls,
  useChainNow,
  useConfirm,
  usePoll,
} from "./ui";
import { useWallet } from "./wallet";
import { calloutClass, eyebrowClass, sectionClass } from "@/lib/ui-classes";

type EvidenceRow = { contentHash: Hex; submitter: Address; submittedAt: bigint };
type HistoryRow = Awaited<ReturnType<typeof escrowHistory>>[number];
type Act = (label: string, functionName: string, args: unknown[]) => Promise<unknown>;

const EVENT_LABEL: Record<string, string> = {
  EscrowCreated: "Escrow created and funded",
  TermsAccepted: "Payee accepted the terms",
  OfferMade: "Settlement offer",
  OfferWithdrawn: "Offer withdrawn",
  DisputeOpened: "Dispute opened",
  EvidenceSubmitted: "Evidence committed",
  Proposed: "Mediator proposal submitted",
  ProposalResponse: "Proposal response",
  Settled: "Settled: funds released",
};

const MAX_FILE = 5 * 1024 * 1024;

export function EscrowDetail({ id, go }: { id: bigint; go?: (path: string) => void }) {
  const { address, wallet, connect } = useWallet();
  const { run } = useTx();
  const confirm = useConfirm();
  const [e, setE] = useState<Escrow>();
  const [evidence, setEvidence] = useState<EvidenceRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [history, setHistory] = useState<HistoryRow[]>();
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const now = useChainNow(offset);

  const load = useCallback(async () => {
    try {
      const [esc, ev, off] = await Promise.all([
        readEscrow(id),
        publicClient.readContract({ ...escrowContract, functionName: "getEvidence", args: [id] }),
        chainTimeOffsetMs(),
      ]);
      setE(esc);
      setEvidence([...ev]);
      setOffset(off);
      setLoadError(undefined);
    } catch (err) {
      setLoadError(explainError(err));
    }
  }, [id]);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await escrowHistory(id));
    } catch {
      setHistory([]);
    }
  }, [id]);

  usePoll(load, 6000);
  useEffect(() => {
    const t = setTimeout(() => void loadHistory(), 0);
    return () => clearTimeout(t);
  }, [loadHistory]);

  if (loadError && !e) {
    const notFound = /doesn't exist/.test(loadError);
    return (
      <div className="mx-auto max-w-lg">
        <Card>
          <EmptyState
            icon={<IconAlert size={22} />}
            title={notFound ? `Escrow #${id} doesn't exist` : `Couldn't load escrow #${id}`}
            body={notFound ? "Check the number, or open it from My escrows." : loadError}
            action={
              <div className="flex gap-2">
                {!notFound && <Button variant="secondary" onClick={() => void load()}><IconRefresh /> Try again</Button>}
                <Button onClick={() => go?.("/")}>Back to my escrows</Button>
              </div>
            }
          />
        </Card>
      </div>
    );
  }
  if (!e) return <DetailSkeleton />;

  const role = roleOf(e, address);
  const me = address?.toLowerCase();
  const isParty = role === "payer" || role === "payee";
  const n = BigInt(now);

  /** Simulate → sign → confirm → refresh. Contract errors surface before the wallet opens. */
  const act: Act = async (label, functionName, args) => {
    if (!wallet || !address) return;
    setBusy(functionName);
    setActionError(undefined);
    try {
      const call = { address: config.escrow, abi: escrowContract.abi as Abi, functionName, args, account: address };
      await publicClient.simulateContract(call);
      const r = await run(label, () => wallet.writeContract({ ...call, chain: wallet.chain, type: "legacy" } as never) as Promise<Hash>);
      if (r) {
        await load();
        void loadHistory();
      }
      return r;
    } catch (err) {
      setActionError(explainError(err));
    } finally {
      setBusy(undefined);
    }
  };

  const canFinalize = finalizeReady(e, n);
  const open = e.status >= Status.AwaitingPayee && e.status <= Status.Proposed;

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <a href="#/" className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-foreground">
          <IconArrowLeft size={14} /> My escrows
        </a>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Escrow #{id.toString()}</h1>
              <StatusBadge status={e.status} />
              <Badge tone={role === "observer" ? "neutral" : "info"} dot={false}>{role === "observer" ? "Viewing only" : `You're the ${ROLE_LABEL[role].toLowerCase()}`}</Badge>
            </div>
            <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400">Created {fmtDate(e.createdAt)}</p>
          </div>
          <div className="text-left sm:text-right">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{open ? "Held in escrow" : "Escrow amount"}</p>
            <Amount value={fmtAmount(e.amount)} size="xl" />
          </div>
        </div>
      </div>

      <Stepper e={e} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <NextStep e={e} now={n} offset={offset} />

          {actionError && (
            <Notice tone="error" title="That didn't go through" action={<button type="button" className="rounded-lg p-1 transition-colors hover:bg-red-100 dark:hover:bg-red-900/30" onClick={() => setActionError(undefined)} aria-label="Dismiss error"><IconX /></button>}>
              {actionError}
            </Notice>
          )}
          {!address && (
            <Notice tone="info" title="You're viewing a public escrow" action={<Button size="sm" onClick={connect}>Connect wallet</Button>}>
              Everything here is read straight from the chain. Connect the payer or payee wallet to take action.
            </Notice>
          )}
          {address && role === "observer" && open && (
            <Notice tone="info">This wallet isn&apos;t a party to this escrow, so you can only view it. Anyone can still trigger a deadline outcome once it&apos;s due.</Notice>
          )}

          {canFinalize && (
            <Card title="A deadline has passed" tone="highlight" description="Anyone can apply the pre-agreed outcome now. No mediator or server is needed.">
              <FinalizePreview e={e} />
              <Button className="mt-4" busy={busy === "finalize"} busyLabel="Finalizing…" disabled={!wallet} onClick={() => act("Finalize escrow", "finalize", [id])}>
                Finalize and release funds
              </Button>
              {!wallet && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Connect any wallet to finalize.</p>}
            </Card>
          )}

          {e.status === Status.AwaitingPayee && n < e.acceptBy && <AcceptPanel e={e} id={id} role={role} busy={busy} act={act} />}

          {e.status === Status.Proposed && (
            <ProposalPanel
              e={e}
              role={role}
              now={n}
              offset={offset}
              busy={busy}
              act={async (accept) => {
                if (!accept) {
                  const ok = await confirm({
                    title: "Reject the mediator's proposal?",
                    body: (
                      <>
                        Rejecting settles the escrow <strong>right away</strong> with the pre-agreed fallback: the payee receives{" "}
                        <strong>{fmtAmount((e.amount * BigInt(e.disputeFallbackPayeeBps)) / 10000n)} tUSD8 ({pct(e.disputeFallbackPayeeBps)})</strong>. This can&apos;t be undone.
                      </>
                    ),
                    confirmLabel: "Reject and settle",
                    tone: "danger",
                  });
                  if (!ok) return;
                }
                return act(accept ? "Accept proposal" : "Reject proposal", "respondToProposal", [id, accept]);
              }}
            />
          )}

          {isParty && (e.status === Status.Active || e.status === Status.Disputed || e.status === Status.Proposed) && (
            <OfferPanel e={e} role={role as "payer" | "payee"} busy={busy} act={act} id={id} />
          )}

          {isParty && e.status === Status.Active && n < e.activeDeadline && (
            <Card title="Something went wrong?" description="Opening a dispute pauses the automatic payout and brings in the mediator.">
              <ol className="grid gap-3 text-sm sm:grid-cols-3">
                <MiniStep n={1} title="Add evidence" body={`Both sides get ${fmtWin(e.evidenceWindow)}.`} />
                <MiniStep n={2} title="AI proposes" body={`Within ${fmtWin(e.proposeWindow)} after evidence closes.`} />
                <MiniStep n={3} title="You decide" body={`Accept, or reject for the fallback (payee ${pct(e.disputeFallbackPayeeBps)}).`} />
              </ol>
              <Button
                variant="danger"
                className="mt-4"
                busy={busy === "openDispute"}
                busyLabel="Opening dispute…"
                onClick={async () => {
                  const ok = await confirm({
                    title: "Open a dispute?",
                    body: <>The automatic payout stops and the evidence window opens for <strong>{fmtWin(e.evidenceWindow)}</strong>. You can still settle by agreement at any point. A dispute can&apos;t be withdrawn.</>,
                    confirmLabel: "Open dispute",
                    tone: "danger",
                  });
                  if (ok) await act("Open dispute", "openDispute", [id]);
                }}
              >
                Open dispute
              </Button>
            </Card>
          )}

          <EvidencePanel e={e} id={id} evidence={evidence} role={role} now={n} onChange={() => { void load(); void loadHistory(); }} />

          {(e.status === Status.Settled || e.status === Status.Cancelled) && <Outcome e={e} />}
        </div>

        <div className="space-y-6">
          <Card title="Parties">
            <dl className="space-y-3 text-sm">
              <PartyRow label="Payer" a={e.payer} me={me} />
              <PartyRow label="Payee" a={e.payee} me={me} />
              <PartyRow label="Mediator" a={e.mediator} me={me} note="recommends only" />
              {e.proposer !== "0x0000000000000000000000000000000000000000" && <PartyRow label="Proposal signed by" a={e.proposer} me={me} note="session key" />}
            </dl>
          </Card>

          <Card title="Rules set at creation" description="These can't be changed by anyone.">
            <dl className="divide-y divide-gray-100 dark:divide-gray-700 text-sm">
              <KV k="If no dispute" v={`Payee ${pct(e.undisputedPayeeBps)}`} />
              <KV k="If mediation fails" v={`Payee ${pct(e.disputeFallbackPayeeBps)}`} />
              <KV k="Accept by" v={fmtDate(e.acceptBy)} />
              <KV k="Dispute period" v={fmtWin(e.activeDuration)} />
              <KV k="Evidence window" v={fmtWin(e.evidenceWindow)} />
              <KV k="Mediator window" v={fmtWin(e.proposeWindow)} />
              <KV k="Response window" v={fmtWin(e.responseWindow)} />
              <KV k="Terms fingerprint" v={<span className="inline-flex items-center gap-1 font-mono text-xs" title={e.termsHash}>{short(e.termsHash)} <CopyButton value={e.termsHash} label="Copy terms hash" /></span>} />
            </dl>
          </Card>

          <Card
            title="On-chain audit trail"
            description="Every step, with a link to the explorer."
            action={<Button size="sm" variant="ghost" onClick={() => { setHistory(undefined); void loadHistory(); }} aria-label="Refresh audit trail"><IconRefresh size={14} /></Button>}
          >
            {history === undefined ? (
              <div className="space-y-3" aria-busy="true" aria-label="Loading history">
                {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}
              </div>
            ) : history.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">No events found in the recent block range. The status above is still read live from the contract.</p>
            ) : (
              <ol className="relative space-y-4 border-l-2 border-gray-100 dark:border-gray-700 pl-5">
                {history.map((h, i) => (
                  <li key={`${h.tx}-${i}`} className="relative">
                    <span className={cx("absolute -left-[1.65rem] top-1 h-3 w-3 rounded-full ring-4 ring-white dark:ring-gray-800", h.event === "Settled" ? "bg-green-500" : h.event === "DisputeOpened" ? "bg-red-500" : h.event === "Proposed" ? "bg-gray-900 dark:bg-gray-100" : "bg-gray-400 dark:bg-gray-500")} aria-hidden />
                    <p className="text-sm font-medium leading-snug">{EVENT_LABEL[h.event] ?? h.event}{eventDetail(h, e)}</p>
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Block {h.block.toString()} · <TxLink hash={h.tx} /></p>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading escrow">
      <Skeleton className="h-4 w-24" />
      <div className="flex justify-between"><Skeleton className="h-9 w-56" /><Skeleton className="h-10 w-40" /></div>
      <Skeleton className="h-8 w-full max-w-xl" />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6"><Skeleton className="h-40 rounded-xl" /><Skeleton className="h-56 rounded-xl" /></div>
        <div className="space-y-6"><Skeleton className="h-40 rounded-xl" /><Skeleton className="h-64 rounded-xl" /></div>
      </div>
    </div>
  );
}

function eventDetail(h: HistoryRow, e: Escrow): string {
  const a = h.args;
  if (h.event === "OfferMade") return `: payee ${fmtAmount(a.payeeAmount as bigint)} (by ${partyName(a.party as string, e)})`;
  if (h.event === "ProposalResponse") return `: ${partyName(a.party as string, e)} ${a.accepted ? "accepted" : "rejected"}`;
  if (h.event === "DisputeOpened") return ` by ${partyName(a.by as string, e)}`;
  if (h.event === "Proposed") return `: payee ${fmtAmount(a.payeeAmount as bigint)}`;
  if (h.event === "Settled") return `: payee ${fmtAmount(a.payeeAmount as bigint)} / payer ${fmtAmount(a.payerAmount as bigint)}`;
  if (h.event === "EvidenceSubmitted") return ` by ${partyName(a.submitter as string, e)}`;
  return "";
}

const partyName = (a: string, e: Escrow) => (a.toLowerCase() === e.payer.toLowerCase() ? "payer" : a.toLowerCase() === e.payee.toLowerCase() ? "payee" : short(a));

function fmtWin(s: bigint) {
  const n = Number(s);
  if (n % 86400 === 0) return `${n / 86400} day${n === 86400 ? "" : "s"}`;
  if (n % 3600 === 0) return `${n / 3600} hour${n === 3600 ? "" : "s"}`;
  return `${Math.round(n / 60)} min`;
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-2 first:pt-0 last:pb-0">
      <dt className="text-gray-500 dark:text-gray-400">{k}</dt>
      <dd className="text-right font-medium">{v}</dd>
    </div>
  );
}

function PartyRow({ label, a, me, note }: { label: string; a: string; me?: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <dt className="text-gray-500 dark:text-gray-400">
        {label}
        {note && <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">({note})</span>}
      </dt>
      <dd><AddressLink address={a} you={me === a.toLowerCase()} /></dd>
    </div>
  );
}

function MiniStep({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className="rounded-lg bg-gray-50 dark:bg-gray-900/50 p-3">
      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400">Step {n}</p>
      <p className="mt-0.5 font-medium">{title}</p>
      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{body}</p>
    </li>
  );
}

function Stepper({ e }: { e: Escrow }) {
  const disputed = e.evidenceDeadline > 0n;
  const closed = e.status >= Status.Settled;
  const steps = [
    { label: "Funded", done: true },
    { label: "Accepted", done: e.activeDeadline > 0n },
    ...(disputed ? [{ label: "Disputed", done: true }, { label: "Proposal", done: e.responseDeadline > 0n }] : []),
    { label: e.status === Status.Cancelled ? "Refunded" : "Settled", done: closed },
  ];
  const current = steps.findIndex((s) => !s.done);
  return (
    <nav aria-label="Escrow progress" className="overflow-x-auto px-4 py-3 rounded-xl border border-gray-100 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <ol className="flex min-w-max items-center gap-2 sm:gap-3">
        {steps.map((s, i) => (
          <li key={s.label} className="flex items-center gap-2 sm:gap-3" aria-current={i === current ? "step" : undefined}>
            <span
              className={cx(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                s.done ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900" : i === current ? "border-2 border-gray-900 dark:border-gray-100 bg-white dark:bg-gray-900 text-gray-900 dark:text-white" : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
              )}
            >
              {s.done ? <IconCheck size={14} /> : i + 1}
            </span>
            <span className={cx("whitespace-nowrap text-sm", s.done || i === current ? "font-semibold text-gray-900 dark:text-white" : "text-gray-500 dark:text-gray-400")}>
              {s.label}
              <span className="sr-only">{s.done ? " (done)" : i === current ? " (current)" : " (upcoming)"}</span>
            </span>
            {i < steps.length - 1 && <span className={cx("h-0.5 w-6 rounded sm:w-12", s.done ? "bg-gray-900 dark:bg-gray-100" : "bg-gray-200 dark:bg-gray-700")} aria-hidden />}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function NextStep({ e, now, offset }: { e: Escrow; now: bigint; offset: number }) {
  const phase = describePhase(e, now);
  const closed = e.status >= Status.Settled;
  const passed = phase.deadline !== undefined && now >= phase.deadline;
  return (
    <section aria-labelledby="next-step-title" className={cx(sectionClass, "p-5 sm:p-6")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={eyebrowClass}>{closed ? "Outcome" : "Where things stand"}</p>
        <StatusBadge status={e.status} />
      </div>
      <h2 id="next-step-title" className="mt-2 text-xl font-semibold tracking-tight text-gray-900 dark:text-white">{phase.title}</h2>
      <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-gray-600 dark:text-gray-300">{phase.body}</p>
      {phase.deadline !== undefined && (
        <div className={cx(calloutClass, "mt-5 grid gap-3 p-4")}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              <IconClock size={16} className="text-gray-400 dark:text-gray-500" /> {phase.deadlineLabel}{" "}
              <span className={cx("text-lg font-semibold tabular-nums", passed ? "text-amber-600 dark:text-amber-400" : "text-gray-900 dark:text-white")}>
                {passed ? "· deadline passed" : <>in <Countdown deadline={phase.deadline} offsetMs={offset} done="now" /></>}
              </span>
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">{fmtDate(phase.deadline)}</p>
          </div>
          {phase.start !== undefined && <TimeBar start={Number(phase.start)} end={Number(phase.deadline)} now={Number(now)} />}
          {phase.ifNobodyActs && (
            <p className="text-sm text-gray-600 dark:text-gray-300"><span className="font-semibold text-gray-900 dark:text-white">If nobody acts:</span> {phase.ifNobodyActs}</p>
          )}
        </div>
      )}
    </section>
  );
}

function FinalizePreview({ e }: { e: Escrow }) {
  let payee = 0n;
  let reason = "";
  if (e.status === Status.AwaitingPayee) reason = "The payee didn't accept in time, so the payer is refunded in full.";
  else if (e.status === Status.Active) {
    payee = (e.amount * BigInt(e.undisputedPayeeBps)) / 10000n;
    reason = "Nobody disputed, so the undisputed split applies.";
  } else if (e.status === Status.Disputed) {
    payee = (e.amount * BigInt(e.disputeFallbackPayeeBps)) / 10000n;
    reason = "The mediator didn't propose in time, so the fallback split applies.";
  } else if (e.status === Status.Proposed) {
    payee = e.proposedPayeeAmount;
    reason = "Nobody rejected the proposal, so it executes as written.";
  }
  return (
    <div className="space-y-3 text-sm">
      <p className="text-gray-700 dark:text-gray-300">{reason}</p>
      <div className="grid grid-cols-2 gap-3">
        <PayoutTile label="Payee receives" value={payee} tone="payee" />
        <PayoutTile label="Payer receives" value={e.amount - payee} tone="payer" />
      </div>
    </div>
  );
}

function PayoutTile({ label, value, tone }: { label: string; value: bigint; tone: "payee" | "payer" }) {
  return (
    <div className={cx("rounded-lg border p-4", tone === "payee" ? "border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/50" : "border-gray-100 dark:border-gray-700")}>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</p>
      <Amount value={fmtAmount(value)} size="lg" />
    </div>
  );
}

function AcceptPanel({ e, id, role, busy, act }: { e: Escrow; id: bigint; role: Role; busy?: string; act: Act }) {
  const { wallet, address } = useWallet();
  const [terms, setTerms] = useState<string>();
  const [loadingTerms, setLoadingTerms] = useState(false);
  const [err, setErr] = useState<string>();
  const [reviewed, setReviewed] = useState(false);
  async function view() {
    if (!wallet || !address) return;
    setErr(undefined);
    setLoadingTerms(true);
    try {
      const opened = await openEvidence({ wallet, account: address, escrowId: id, hash: e.termsHash });
      setTerms(await opened.blob.text());
    } catch (x) {
      setErr(explainError(x));
    } finally {
      setLoadingTerms(false);
    }
  }
  if (role !== "payee" && role !== "payer") return null;
  return (
    <Card
      title={role === "payee" ? "Review and accept the terms" : "Waiting for the payee"}
      description={role === "payee" ? "Read the agreement, then accept. Your acceptance is tied to these exact terms." : "You can read back the agreement, or cancel for a full refund until the payee accepts."}
      tone={role === "payee" ? "highlight" : "default"}
    >
      <div className="rounded-lg bg-gray-50 dark:bg-gray-900/50 p-4">
        {terms ? (
          <>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-green-600 dark:text-green-400"><IconShield size={14} /> Matches the fingerprint stored on-chain</p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-gray-900 dark:text-white">{terms}</pre>
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-500 dark:text-gray-400">The agreement is private. Sign a free message to prove you&apos;re a party and read it.</p>
            <Button variant="secondary" onClick={view} busy={loadingTerms} busyLabel="Waiting for signature…"><IconFile /> View agreement</Button>
          </div>
        )}
      </div>
      {err && <div className="mt-3"><Notice tone="warn" title="Couldn't open the agreement">{err}</Notice></div>}

      {role === "payee" && (
        <>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg p-3 border">
              <dt className="text-xs text-gray-500 dark:text-gray-400">If nobody disputes, you receive</dt>
              <dd className="mt-0.5 font-semibold tabular-nums">{fmtAmount((e.amount * BigInt(e.undisputedPayeeBps)) / 10000n)} tUSD8 <span className="font-normal text-gray-500 dark:text-gray-400">after {fmtWin(e.activeDuration)}</span></dd>
            </div>
            <div className="rounded-lg p-3 border">
              <dt className="text-xs text-gray-500 dark:text-gray-400">If mediation fails, you receive</dt>
              <dd className="mt-0.5 font-semibold tabular-nums">{fmtAmount((e.amount * BigInt(e.disputeFallbackPayeeBps)) / 10000n)} tUSD8</dd>
            </div>
          </dl>
          <label className="mt-4 flex items-start gap-2.5 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={reviewed} onChange={(x) => setReviewed(x.target.checked)} />
            <span>I&apos;ve read the agreement and the rules on this page.</span>
          </label>
          <Button
            className="mt-4"
            disabled={!reviewed}
            busy={busy === "acceptTerms"}
            busyLabel="Accepting…"
            onClick={async () => {
              // Bind acceptance to the exact terms we display.
              const digest = await publicClient.readContract({ ...escrowContract, functionName: "termsDigest", args: [id] });
              await act("Accept terms", "acceptTerms", [id, digest]);
            }}
          >
            <IconHandshake /> Accept these terms
          </Button>
        </>
      )}
      {role === "payer" && <CancelButton id={id} e={e} busy={busy} act={act} />}
    </Card>
  );
}

function CancelButton({ id, e, busy, act }: { id: bigint; e: Escrow; busy?: string; act: Act }) {
  const confirm = useConfirm();
  return (
    <Button
      variant="secondary"
      className="mt-4"
      busy={busy === "cancel"}
      busyLabel="Cancelling…"
      onClick={async () => {
        const ok = await confirm({
          title: "Cancel this escrow?",
          body: <>The full <strong>{fmtAmount(e.amount)} tUSD8</strong> returns to your wallet and the payee can no longer accept. This can&apos;t be undone.</>,
          confirmLabel: "Cancel and refund me",
          tone: "danger",
        });
        if (ok) await act("Cancel escrow", "cancel", [id]);
      }}
    >
      Cancel and refund me
    </Button>
  );
}

function OfferPanel({ e, id, role, busy, act }: { e: Escrow; id: bigint; role: "payer" | "payee"; busy?: string; act: Act }) {
  const mine = role === "payer" ? (e.payerOffered ? e.payerOffer : undefined) : e.payeeOffered ? e.payeeOffer : undefined;
  const theirs = role === "payer" ? (e.payeeOffered ? e.payeeOffer : undefined) : e.payerOffered ? e.payerOffer : undefined;
  const [value, setValue] = useState(() => formatUnits(theirs !== undefined ? theirs : e.amount / 2n, config.tokenDecimals));
  let parsed = -1n;
  try {
    parsed = parseAmount(value);
  } catch {}
  const valid = parsed >= 0n && parsed <= e.amount;
  const bps = valid && e.amount > 0n ? Number((parsed * 10000n) / e.amount) : 0;
  const matches = theirs !== undefined && theirs === parsed;
  return (
    <Card title="Settle by agreement" description="Propose how much the payee receives. If the other side offers the same amount, funds are released immediately, with no mediator needed.">
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <OfferTile label="Your offer" value={mine} />
        <OfferTile
          label="Their offer"
          value={theirs}
          action={theirs !== undefined && !matches ? <Button size="sm" variant="secondary" onClick={() => setValue(formatUnits(theirs, config.tokenDecimals))}>Use this</Button> : undefined}
        />
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-start">
        <Field label="Payee receives" error={valid ? undefined : `Enter an amount between 0 and ${fmtAmount(e.amount)}.`} hint={valid ? `Payer gets ${fmtAmount(e.amount - parsed)} tUSD8 back` : undefined}>
          {(ctl) => (
            <div className="relative">
              <input {...ctl} className={`${inputCls} pr-16 tabular-nums`} inputMode="decimal" value={value} onChange={(x) => setValue(x.target.value)} />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm font-medium text-gray-500 dark:text-gray-400">tUSD8</span>
            </div>
          )}
        </Field>
        <div className="flex gap-2 sm:mt-7">
          <Button busy={busy === "offerSettlement"} busyLabel="Sending…" disabled={!valid} onClick={() => act(matches ? "Accept their offer" : "Offer settlement", "offerSettlement", [id, parsed])}>
            {matches ? "Match & settle now" : "Send offer"}
          </Button>
          {mine !== undefined && <Button variant="ghost" busy={busy === "withdrawOffer"} onClick={() => act("Withdraw offer", "withdrawOffer", [id])}>Withdraw</Button>}
        </div>
      </div>
      {valid && <div className="mt-4"><SplitBar payeeBps={bps} /></div>}
      {matches && <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-green-600 dark:text-green-400"><IconCheck size={14} /> This matches their offer. Sending it settles the escrow immediately.</p>}
    </Card>
  );
}

function OfferTile({ label, value, action }: { label: string; value?: bigint; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 dark:bg-gray-900/50 p-3">
      <div>
        <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
        <p className="font-semibold tabular-nums">{value !== undefined ? <>{fmtAmount(value)} <span className="font-normal text-gray-500 dark:text-gray-400">to payee</span></> : <span className="font-normal text-gray-500 dark:text-gray-400">No offer yet</span>}</p>
      </div>
      {action}
    </div>
  );
}

function ProposalPanel({ e, role, now, offset, busy, act }: { e: Escrow; role: Role; now: bigint; offset: number; busy?: string; act: (accept: boolean) => Promise<unknown> }) {
  const [reasoning, setReasoning] = useState<{ doc: ReasoningDoc; verified: boolean }>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    fetchReasoning(e.reasoningHash).then(setReasoning).catch((x) => setErr(explainError(x)));
  }, [e.reasoningHash]);
  const payeeBps = e.amount > 0n ? Number((e.proposedPayeeAmount * 10000n) / e.amount) : 0;
  const myAccepted = role === "payer" ? e.payerAcceptedProposal : role === "payee" ? e.payeeAcceptedProposal : false;
  const open = now < e.responseDeadline;
  const d = reasoning?.doc.decision;
  return (
    <Card
      tone="highlight"
      title={<span className="flex items-center gap-2"><IconSparkle className="text-gray-500 dark:text-gray-400" /> Mediator proposal</span>}
      description={open ? <>Respond within <strong><Countdown deadline={e.responseDeadline} offsetMs={offset} /></strong>. If nobody rejects, it executes.</> : "The response window has closed."}
    >
      <div className="grid grid-cols-2 gap-3">
        <PayoutTile label="Payee receives" value={e.proposedPayeeAmount} tone="payee" />
        <PayoutTile label="Payer refunded" value={e.amount - e.proposedPayeeAmount} tone="payer" />
      </div>
      <div className="mt-4"><SplitBar payeeBps={payeeBps} /></div>

      <div className="mt-5 rounded-lg bg-gray-50 dark:bg-gray-900/50 p-4 text-sm">
        {err && <Notice tone="warn" title="Rationale unavailable">The mediator service didn&apos;t respond ({err}). The on-chain commitment is <span className="font-mono">{short(e.reasoningHash)}</span>.</Notice>}
        {!err && !reasoning && (
          <div className="space-y-2" aria-busy="true" aria-label="Loading rationale">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        )}
        {reasoning && d && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {reasoning.verified ? <Badge tone="success">Rationale matches on-chain hash</Badge> : <Badge tone="danger">Rationale does NOT match on-chain hash</Badge>}
              <Badge tone={d.confidence === "high" ? "success" : d.confidence === "medium" ? "info" : "warn"} dot={false}>Confidence: {d.confidence}</Badge>
              <Badge tone="ai" dot={false}>{reasoning.doc.engine.mode === "claude" ? `AI · ${reasoning.doc.engine.servedBy ?? reasoning.doc.engine.model}` : "Rules engine"}</Badge>
            </div>
            {!reasoning.verified && <Notice tone="error">The rationale served by the mediator differs from what it committed on-chain. Treat it with suspicion; the on-chain amounts above are still authoritative.</Notice>}
            {d.suspicious_instructions_detected && <Notice tone="warn" title="Manipulation attempt detected">The mediator found instructions hidden in submitted evidence and ignored them.</Notice>}
            <p className="text-base font-medium leading-relaxed text-gray-900 dark:text-white">{d.summary}</p>
            {d.findings.length > 0 && (
              <ul className="space-y-2">
                {d.findings.map((f, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span className={cx("mt-0.5 shrink-0 rounded px-1.5 py-px text-[11px] font-semibold", f.party === "payer" ? "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200" : "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900")}>
                      #{f.evidence_index} {f.party}
                    </span>
                    <span className="text-gray-700 dark:text-gray-300">{f.assessment}</span>
                  </li>
                ))}
              </ul>
            )}
            <details className="group">
              <summary className="cursor-pointer font-medium text-gray-900 dark:text-white">Read the full rationale</summary>
              <p className="mt-2 whitespace-pre-wrap leading-relaxed text-gray-700 dark:text-gray-300">{d.rationale}</p>
            </details>
          </div>
        )}
      </div>

      <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm" aria-label="Responses so far">
        <li className="flex items-center gap-1.5">{e.payerAcceptedProposal ? <IconCheck size={14} className="text-green-600 dark:text-green-400" /> : <IconClock size={14} className="text-gray-500 dark:text-gray-400" />} Payer: {e.payerAcceptedProposal ? "accepted" : "no response yet"}</li>
        <li className="flex items-center gap-1.5">{e.payeeAcceptedProposal ? <IconCheck size={14} className="text-green-600 dark:text-green-400" /> : <IconClock size={14} className="text-gray-500 dark:text-gray-400" />} Payee: {e.payeeAcceptedProposal ? "accepted" : "no response yet"}</li>
      </ul>

      {(role === "payer" || role === "payee") && open && !myAccepted && (
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Button busy={busy === "respondToProposal"} busyLabel="Submitting…" onClick={() => act(true)}><IconCheck /> Accept proposal</Button>
          <Button variant="secondary" className="text-red-600 dark:text-red-400" disabled={busy === "respondToProposal"} onClick={() => act(false)}>
            Reject → fallback {pct(e.disputeFallbackPayeeBps)} to payee
          </Button>
        </div>
      )}
      {myAccepted && open && <Notice tone="success">You accepted. It executes as soon as the other party accepts, or automatically when the timer ends.</Notice>}
    </Card>
  );
}

function fmtBytes(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function EvidencePanel({ e, id, evidence, role, now, onChange }: { e: Escrow; id: bigint; evidence: EvidenceRow[]; role: Role; now: bigint; onChange: () => void }) {
  const { wallet, address } = useWallet();
  const { run } = useTx();
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string>();
  const [err, setErr] = useState<string>();
  const [opening, setOpening] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const isParty = role === "payer" || role === "payee";
  const canAdd = isParty && (e.status === Status.Active || (e.status === Status.Disputed && now < e.evidenceDeadline));

  function pick(f?: File) {
    setErr(undefined);
    if (f && f.size > MAX_FILE) {
      setErr(`"${f.name}" is ${fmtBytes(f.size)}. Files must be 5 MB or smaller.`);
      return;
    }
    setFile(f);
  }

  async function add() {
    if (!wallet || !address || !file) return;
    setBusy(true);
    setErr(undefined);
    try {
      if (file.size > MAX_FILE) throw new Error("Files must be 5 MB or smaller.");
      setStage("Hashing in your browser…");
      const { bytes, hash } = await hashFile(file);
      setStage("Sign to upload privately…");
      const { contentHash, uri } = await uploadEvidence({ wallet, account: address, escrowId: id, bytes, name: file.name, mimeType: file.type || "application/octet-stream", kind: "evidence" });
      if (contentHash.toLowerCase() !== hash.toLowerCase()) throw new Error("Hash mismatch after upload");
      setStage("Commit the fingerprint on-chain…");
      const call = { ...escrowContract, functionName: "submitEvidence", args: [id, contentHash, uri], account: address } as const;
      await publicClient.simulateContract(call);
      const r = await run("Commit evidence hash", () => wallet.writeContract({ ...call, chain: wallet.chain, type: "legacy" }));
      if (r) {
        setFile(undefined);
        onChange();
      }
    } catch (x) {
      setErr(explainError(x));
    } finally {
      setBusy(false);
      setStage(undefined);
    }
  }

  async function view(hash: Hex) {
    if (!wallet || !address) return;
    setErr(undefined);
    setOpening(hash);
    try {
      showEvidence(await openEvidence({ wallet, account: address, escrowId: id, hash }));
    } catch (x) {
      setErr(explainError(x));
    } finally {
      setOpening(undefined);
    }
  }

  const onDrop = (ev: DragEvent) => {
    ev.preventDefault();
    setDragging(false);
    pick(ev.dataTransfer.files?.[0]);
  };

  return (
    <Card
      title={`Evidence (${evidence.length})`}
      description="Files stay private in the mediator's store. Only their fingerprints are public, so nobody can swap a file later."
      action={e.status === Status.Disputed && now < e.evidenceDeadline ? <Badge tone="danger">Window open</Badge> : undefined}
    >
      {evidence.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600">
          <EmptyState icon={<IconFile size={20} />} title="No evidence yet" body={canAdd ? "Add delivery receipts, screenshots, chat logs or photos." : "Neither party has submitted evidence."} />
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-700">
          {evidence.map((ev, i) => {
            const who = partyName(ev.submitter, e);
            return (
              <li key={i} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 items-center gap-3">
                  <span className={cx("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", who === "payer" ? "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200" : "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900")}>
                    <IconFile />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">#{i} from the {who}</p>
                    <p className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                      <span className="font-mono" title={ev.contentHash}>{short(ev.contentHash)}</span>
                      <CopyButton value={ev.contentHash} label="Copy evidence hash" /> · {fmtDate(ev.submittedAt)}
                    </p>
                  </div>
                </div>
                {isParty && (
                  <Button size="sm" variant="secondary" busy={opening === ev.contentHash} busyLabel="Verifying…" onClick={() => view(ev.contentHash)}>
                    <IconShield size={14} /> Open &amp; verify
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canAdd && (
        <div className="mt-5">
          <label
            onDragOver={(ev) => { ev.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cx(
              "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center transition has-[:focus-visible]:border-ring",
              dragging ? "border-gray-900 bg-gray-50 dark:border-gray-100 dark:bg-gray-900/50" : "border-gray-300 hover:border-gray-400 hover:bg-gray-50 dark:border-gray-600 dark:hover:border-gray-500 dark:hover:bg-gray-800/50",
            )}
          >
            <IconUpload size={22} className="text-gray-500 dark:text-gray-400" />
            <span className="text-sm font-medium">{file ? "Choose a different file" : "Drop a file here or click to browse"}</span>
            <span className="text-xs text-gray-500 dark:text-gray-400">Text, JSON, PDF or images up to 5 MB. Text, images and PDFs are reviewed by the AI.</span>
            <input type="file" className="sr-only" accept=".txt,.md,.json,.pdf,image/*" onChange={(x) => pick(x.target.files?.[0])} />
          </label>
          {file && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-gray-50 dark:bg-gray-900/50 p-3">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <IconFile className="shrink-0 text-gray-500 dark:text-gray-400" />
                <span className="truncate font-medium">{file.name}</span>
                <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">{fmtBytes(file.size)}</span>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setFile(undefined)} disabled={busy}>Remove</Button>
                <Button size="sm" busy={busy} busyLabel={stage ?? "Working…"} onClick={add}><IconUpload size={14} /> Upload &amp; commit</Button>
              </div>
            </div>
          )}
        </div>
      )}
      {err && <div className="mt-3"><Notice tone="error">{err}</Notice></div>}
    </Card>
  );
}

function Outcome({ e }: { e: Escrow }) {
  return (
    <Card title="Final outcome" description={`${Resolution[e.resolution]} · ${fmtDate(e.settledAt)}`}>
      <div className="grid grid-cols-2 gap-3">
        <PayoutTile label="Paid to payee" value={e.payeePaid} tone="payee" />
        <PayoutTile label="Returned to payer" value={e.payerPaid} tone="payer" />
      </div>
      <p className="mt-4 flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400"><IconCheck size={14} className="text-green-600 dark:text-green-400" /> Closed. No further actions are possible on this escrow.</p>
    </Card>
  );
}
