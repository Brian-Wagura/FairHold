"use client";

import { useCallback, useState } from "react";
import { isAddress, type Abi, type Address, type Hash } from "viem";
import { chainTimeOffsetMs, escrowContract, publicClient } from "@/lib/chain";
import { config } from "@/lib/config";
import { explainError, fmtDate, fmtDuration, short } from "@/lib/format";
import { tableCellClass, tableHeadCellClass, tableRowClass } from "@/lib/ui-classes";
import { mediatorHealth, mediatorJobs, type Health, type MediatorJob } from "@/lib/mediator-api";
import { IconCheck, IconKey, IconRefresh, IconShield, IconSparkle } from "./icons";
import { useTx } from "./tx";
import { Badge, Button, Card, EmptyState, Field, Notice, PageHeader, Skeleton, TxLink, cx, inputCls, useChainNow, useConfirm, usePoll, type Tone } from "./ui";
import { useWallet } from "./wallet";

const ZERO = "0x0000000000000000000000000000000000000000";
type Mediator = Awaited<ReturnType<typeof readMediator>>;
const readMediator = (a: Address) => publicClient.readContract({ ...escrowContract, functionName: "getMediator", args: [a] });

const JOB_TONE: Record<string, Tone> = { submitted: "success", pending: "info", deciding: "ai", blocked: "warn", submitting: "info", failed: "danger", skipped: "neutral" };
const JOB_LABEL: Record<string, string> = {
  submitted: "Proposal submitted",
  pending: "Retrying soon",
  deciding: "Reviewing evidence",
  blocked: "Waiting for session key",
  submitting: "Submitting",
  failed: "Failed",
  skipped: "Skipped (window closed)",
};
const DAY_PRESETS = [1, 7, 14, 30];
const BUDGET_PRESETS = [10, 25, 50];

function PresetChips({ label, values, value, onPick, unit }: { label: string; values: number[]; value: number; onPick: (v: number) => void; unit: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {values.map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onPick(v)}
          className={cx(
            "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
            value === v
              ? "border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900"
              : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-600",
          )}
        >
          {v} {unit}
        </button>
      ))}
    </div>
  );
}

type StepStatus = "done" | "todo" | "problem";
function SetupStep({ n, title, status, detail, href }: { n: number; title: string; status: StepStatus; detail: string; href: string }) {
  return (
    <li>
      <a
        href={`#${href}`}
        onClick={(e) => { e.preventDefault(); document.getElementById(href)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
        className="flex h-full items-start gap-3 rounded-xl border border-gray-100 bg-white p-4 shadow-sm transition-colors hover:border-gray-200 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-gray-600"
      >
        <span
          className={cx(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
            status === "done" && "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900",
            status === "todo" && "border border-gray-300 text-gray-500 dark:border-gray-600 dark:text-gray-400",
            status === "problem" && "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
          )}
          aria-hidden
        >
          {status === "done" ? <IconCheck size={14} /> : status === "problem" ? "!" : n}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-gray-900 dark:text-white">{title}</span>
          <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">{detail}</span>
          <span className="sr-only">{status === "done" ? "Done" : status === "problem" ? "Needs attention" : "To do"}</span>
        </span>
      </a>
    </li>
  );
}

export function MediatorConsole() {
  const { address, wallet, connect, connecting } = useWallet();
  const { run } = useTx();
  const confirm = useConfirm();
  const [mRaw, setM] = useState<Mediator>();
  // Chain time offset (chain - local ms); undefined until fetched, so no estimate uses local time.
  const [chainOffset, setChainOffset] = useState<number>();
  const [loadedFor, setLoadedFor] = useState<string>();
  const [health, setHealth] = useState<Health>();
  const [jobs, setJobs] = useState<MediatorJob[]>([]);
  const [svcErr, setSvcErr] = useState<string>();
  const [err, setErr] = useState<string>();
  const [uri, setUri] = useState("https://github.com/fairhold#mediator-policy-v1");
  const [key, setKey] = useState("");
  const [days, setDays] = useState(7);
  const [budget, setBudget] = useState(25);
  const [busy, setBusy] = useState<string>();
  const [keyTouched, setKeyTouched] = useState(false);

  const load = useCallback(async () => {
    chainTimeOffsetMs().then(setChainOffset).catch(() => undefined);
    if (address) {
      setM(await readMediator(address).catch(() => undefined));
      setLoadedFor(address);
    }
    try {
      const [h, j] = await Promise.all([mediatorHealth(), mediatorJobs()]);
      setHealth(h);
      setJobs(j);
      setSvcErr(undefined);
      if (h.sessionKey) setKey((k) => k || h.sessionKey!);
    } catch (x) {
      setSvcErr(explainError(x));
    }
  }, [address]);

  usePoll(load, 10_000);
  const now = useChainNow(chainOffset ?? 0);

  async function act(label: string, functionName: string, args: unknown[]) {
    if (!wallet || !address) return;
    setBusy(functionName);
    setErr(undefined);
    try {
      const call = { address: config.escrow, abi: escrowContract.abi as Abi, functionName, args, account: address };
      await publicClient.simulateContract(call);
      if (await run(label, () => wallet.writeContract({ ...call, chain: wallet.chain, type: "legacy" } as never) as Promise<Hash>)) await load();
    } catch (x) {
      setErr(explainError(x));
    } finally {
      setBusy(undefined);
    }
  }

  // Use the mediator record only when it belongs to the connected wallet (never a stale one).
  const loadingIdentity = Boolean(address && loadedFor !== address);
  const m = address && !loadingIdentity ? mRaw : undefined;
  // Time-based text needs chain time, not just a ticking local clock.
  const clockReady = chainOffset !== undefined && now > 0;
  const sessionLive = Boolean(clockReady && m && m.sessionKey !== ZERO && Number(m.sessionExpiry) > now && m.sessionBudget > 0);
  const keyExpiresSoon = Boolean(sessionLive && m && (Number(m.sessionExpiry) - now < 86_400 || m.sessionBudget <= 2));
  const decided = m ? m.accepted + m.unchallenged + m.rejected : 0;
  const upheld = m && decided > 0 ? Math.round(((m.accepted + m.unchallenged) / decided) * 100) : undefined;
  const keyError = !isAddress(key) ? (key ? "That isn't a valid address." : "Enter the session key address.") : address && key.toLowerCase() === address.toLowerCase() ? "Use a separate key, not this owner wallet." : undefined;
  const daysError = !Number.isInteger(days) || days < 1 || days > 30 ? "Choose 1 to 30 days." : undefined;
  const budgetError = !Number.isInteger(budget) || budget < 1 ? "At least 1 proposal." : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mediator console"
        description="Run an AI mediator safely: your owner wallet stays cold and hands the AI a limited session key that can only propose splits."
      />
      {err && <Notice tone="error" title="That didn't go through">{err}</Notice>}

      <ol className="grid grid-cols-1 gap-3 md:grid-cols-3" aria-label="Setup">
        <SetupStep
          n={1}
          href="med-identity"
          title="Register identity"
          status={m?.registered ? (m.active ? "done" : "problem") : "todo"}
          detail={!address ? "Connect the owner wallet" : loadingIdentity ? "Checking…" : !m?.registered ? "Make this wallet selectable by payers" : m.active ? "Accepting new escrows" : "Paused: no new escrows or proposals"}
        />
        <SetupStep
          n={2}
          href="med-key"
          title="Grant a session key"
          status={sessionLive ? (keyExpiresSoon ? "problem" : "done") : clockReady && m?.registered && m.sessionKey !== ZERO ? "problem" : "todo"}
          detail={
            !address
              ? "Connect the owner wallet"
              : loadingIdentity || (m?.registered && !clockReady)
                ? "Checking…"
                : sessionLive
                  ? `${m!.sessionBudget} proposals left · expires in ${fmtDuration(Number(m!.sessionExpiry) - now)}`
                  : m?.registered && m.sessionKey !== ZERO
                    ? "Expired, revoked or out of budget"
                    : "Propose-only, expiring, budgeted"
          }
        />
        <SetupStep
          n={3}
          href="med-service"
          title="Run the AI service"
          status={svcErr ? "problem" : health ? (health.ok && health.sessionKeyCanPropose ? "done" : "problem") : "todo"}
          detail={svcErr ? "Service unreachable" : !health ? "Checking…" : !health.sessionKeyCanPropose ? "Online, but its key can't propose" : health.ok ? `Online · ${health.mode === "claude" ? "Claude engine" : "rules engine"}` : "Online, last scan failed"}
        />
      </ol>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card id="med-identity" title="Identity & reputation" description="Counted by the escrow contract from real outcomes, so it can't be self-reported.">
          {!address ? (
            <EmptyState icon={<IconShield size={20} />} title="Connect the mediator owner wallet" action={<Button onClick={connect} busy={connecting}>Connect wallet</Button>} />
          ) : loadingIdentity ? (
            <div className="space-y-3" aria-busy="true"><Skeleton className="h-5 w-48" /><Skeleton className="h-16" /></div>
          ) : !m?.registered ? (
            <div className="space-y-4">
              <Notice tone="info">This wallet isn&apos;t a mediator yet. Registering is free apart from gas, and lets payers choose you.</Notice>
              <Field label="Profile URI" hint="Where parties can read your mediation policy, model and fees.">
                <input className={inputCls} value={uri} onChange={(x) => setUri(x.target.value)} />
              </Field>
              <Button busy={busy === "registerMediator"} busyLabel="Registering…" disabled={!uri.trim()} onClick={() => act("Register mediator", "registerMediator", [uri])}>Register this wallet as a mediator</Button>
            </div>
          ) : (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-semibold">{short(address)}</span>
                <Badge tone={m.active ? "success" : "warn"}>{m.active ? "Accepting new escrows" : "Paused"}</Badge>
              </div>
              <p className="truncate text-xs text-gray-500 dark:text-gray-400" title={m.metadataURI}>{m.metadataURI}</p>
              <div className="rounded-lg bg-gray-50 p-4 dark:bg-gray-900/50">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Proposals upheld</p>
                <p className="mt-1 text-2xl font-bold tabular-nums text-gray-900 dark:text-white">{upheld !== undefined ? `${upheld}%` : "–"}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {upheld !== undefined ? `Accepted or unchallenged in ${m.accepted + m.unchallenged} of ${decided} decided disputes` : "No decided disputes yet"}
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {([["Proposals", m.proposals], ["Accepted", m.accepted], ["Unchallenged", m.unchallenged], ["Rejected", m.rejected], ["Missed", m.missed]] as const).map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-gray-50 dark:bg-gray-900/50 p-3 text-center">
                    <dd className="text-xl font-semibold tabular-nums">{v}</dd>
                    <dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400">{k}</dt>
                  </div>
                ))}
              </dl>
              <Button
                variant="secondary"
                busy={busy === "updateMediator"}
                onClick={async () => {
                  if (m.active) {
                    const ok = await confirm({
                      title: "Pause this mediator?",
                      body: "New escrows can't select you, and no proposals can be submitted, not even by the session key. Open disputes will fall back to their pre-agreed split when the mediator window ends.",
                      confirmLabel: "Pause mediator",
                      tone: "danger",
                    });
                    if (!ok) return;
                  }
                  await act(m.active ? "Pause mediator" : "Resume mediator", "updateMediator", [!m.active, m.metadataURI]);
                }}
              >
                {m.active ? "Pause all proposals" : "Resume"}
              </Button>
            </div>
          )}
        </Card>

        <Card id="med-key" title={<span className="flex items-center gap-2"><IconKey className="text-gray-500 dark:text-gray-400" /> AI session key</span>} description="A limited key for the AI service. It can never move funds.">
          {m?.registered ? (
            <div className="space-y-5 text-sm">
              {!clockReady ? (
                <div className="space-y-2" aria-busy="true" aria-label="Checking session key"><Skeleton className="h-12" /></div>
              ) : sessionLive ? (
                <Notice tone={keyExpiresSoon ? "warn" : "success"} title={`Active key ${short(m.sessionKey)}`}>
                  {m.sessionBudget} proposal{m.sessionBudget === 1 ? "" : "s"} left · expires in {fmtDuration(Number(m.sessionExpiry) - now)} ({fmtDate(m.sessionExpiry)})
                  {keyExpiresSoon && <span className="mt-1 block">Renew soon so open disputes aren&apos;t left without a mediator.</span>}
                </Notice>
              ) : (
                <Notice tone="warn" title="No usable session key">The AI service can&apos;t propose right now. Disputes will fall back to their pre-agreed split on timeout.</Notice>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Field label="Session key address" hint="The address of SESSION_KEY_PRIVATE_KEY in the mediator service." error={keyTouched ? keyError : undefined}>
                    <input className={`${inputCls} font-mono`} value={key} onChange={(x) => setKey(x.target.value.trim())} onBlur={() => setKeyTouched(true)} spellCheck={false} />
                  </Field>
                </div>
                <div className="grid gap-2">
                  <Field label="Valid for (days)" hint={daysError ? undefined : clockReady ? `Expires around ${fmtDate(now + days * 86400)}. Up to 30 days.` : "Up to 30 days."} error={daysError}>
                    <input type="number" min={1} max={30} inputMode="numeric" className={inputCls} value={days} onChange={(x) => setDays(Number(x.target.value))} />
                  </Field>
                  <PresetChips label="Duration presets" values={DAY_PRESETS} value={days} onPick={setDays} unit="d" />
                </div>
                <div className="grid gap-2">
                  <Field label="Proposal budget" hint="Hard cap on proposals this key can make." error={budgetError}>
                    <input type="number" min={1} inputMode="numeric" className={inputCls} value={budget} onChange={(x) => setBudget(Number(x.target.value))} />
                  </Field>
                  <PresetChips label="Budget presets" values={BUDGET_PRESETS} value={budget} onPick={setBudget} unit="proposals" />
                </div>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">This key can only submit proposals. It can&apos;t move funds, settle escrows or change your identity.</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={Boolean(keyError || daysError || budgetError)}
                  busy={busy === "setSessionKey"}
                  busyLabel="Granting…"
                  onClick={async () => {
                    const off = await chainTimeOffsetMs();
                    const expiry = BigInt(Math.floor((Date.now() + off) / 1000) + days * 86400 - 60);
                    await act("Grant session key", "setSessionKey", [key, expiry, budget]);
                  }}
                >
                  {sessionLive ? "Replace key" : "Grant scoped key"}
                </Button>
                {sessionLive && (
                  <Button
                    variant="danger"
                    busy={busy === "revokeSessionKey"}
                    busyLabel="Revoking…"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Revoke the session key now?",
                        body: <>Key <span className="font-mono">{short(m.sessionKey)}</span> stops working immediately. The AI service can&apos;t propose until you grant a new key.</>,
                        confirmLabel: "Revoke key",
                        tone: "danger",
                      });
                      if (ok) await act("Revoke session key", "revokeSessionKey", []);
                    }}
                  >
                    Revoke now
                  </Button>
                )}
              </div>
            </div>
          ) : loadingIdentity ? (
            <div className="space-y-3" aria-busy="true"><Skeleton className="h-12" /><Skeleton className="h-24" /></div>
          ) : (
            <EmptyState icon={<IconKey size={20} />} title={address ? "Register first" : "Connect the owner wallet"} body="Session keys belong to a registered mediator identity." />
          )}
        </Card>
      </div>

      <Card
        id="med-service"
        title={<span className="flex items-center gap-2"><IconSparkle className="text-gray-500 dark:text-gray-400" /> Mediator service</span>}
        description={<span className="font-mono text-xs">{config.mediatorApi}</span>}
        action={<Button size="sm" variant="ghost" onClick={() => void load()} aria-label="Refresh service status"><IconRefresh size={14} /> Refresh</Button>}
      >
        {svcErr ? (
          <Notice tone="warn" title="Service unreachable">
            <p>{svcErr}</p>
            <p className="mt-1">Start it with <code className="rounded bg-amber-100 px-1 font-mono text-xs dark:bg-amber-900/40">make mediator</code> (or <code className="rounded bg-amber-100 px-1 font-mono text-xs dark:bg-amber-900/40">docker compose up</code>) and check that NEXT_PUBLIC_MEDIATOR_URL points at it. Disputes still settle by their fallback if it stays down.</p>
          </Notice>
        ) : health ? (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={health.ok ? "success" : "danger"}>{health.ok ? "Healthy" : "Degraded"}</Badge>
              <Badge tone={health.sessionKeyCanPropose ? "success" : "danger"}>{health.sessionKeyCanPropose ? "Key authorized on-chain" : "Key NOT authorized"}</Badge>
              <Badge tone="ai" dot={false}>{health.mode === "claude" ? "Claude engine" : "Rules engine"}</Badge>
              {health.worker.lastTickAt && <span className="text-xs text-gray-500 dark:text-gray-400">Last scan {new Date(health.worker.lastTickAt).toLocaleTimeString()}</span>}
            </div>
            {health.worker.lastTickError && <Notice tone="error" title="Last scan failed">{health.worker.lastTickError}</Notice>}
            {jobs.length === 0 ? (
              <EmptyState title="No mediation jobs yet" body="Jobs appear here when a dispute's evidence window closes." />
            ) : (
              <>
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full overflow-hidden rounded-lg text-left text-sm">
                    <thead>
                      <tr>
                        <th scope="col" className={tableHeadCellClass}>Escrow</th>
                        <th scope="col" className={tableHeadCellClass}>Status</th>
                        <th scope="col" className={tableHeadCellClass}>Attempts</th>
                        <th scope="col" className={tableHeadCellClass}>Transaction</th>
                        <th scope="col" className={tableHeadCellClass}>Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jobs.map((j) => (
                        <tr key={j.escrowId} className={tableRowClass}>
                          <td className={tableCellClass}><a className="font-medium text-gray-900 dark:text-white underline-offset-4 hover:underline" href={`#/escrow/${j.escrowId}`}>#{j.escrowId}</a></td>
                          <td className={tableCellClass}><Badge tone={JOB_TONE[j.status] ?? "neutral"}>{JOB_LABEL[j.status] ?? j.status}</Badge></td>
                          <td className={cx(tableCellClass, "tabular-nums")}>{j.attempts}</td>
                          <td className={tableCellClass}>{j.txHash ? <TxLink hash={j.txHash} /> : <span className="text-gray-500 dark:text-gray-400">–</span>}</td>
                          <td className={cx(tableCellClass, "max-w-64 truncate text-xs text-gray-500 dark:text-gray-400")} title={j.lastError}>{j.lastError ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="space-y-2 md:hidden">
                  {jobs.map((j) => (
                    <li key={j.escrowId} className="rounded-lg p-3 border">
                      <div className="flex items-center justify-between">
                        <a className="font-medium text-gray-900 dark:text-white underline-offset-4 hover:underline" href={`#/escrow/${j.escrowId}`}>Escrow #{j.escrowId}</a>
                        <Badge tone={JOB_TONE[j.status] ?? "neutral"}>{JOB_LABEL[j.status] ?? j.status}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{j.attempts} attempt{j.attempts === 1 ? "" : "s"} {j.txHash && <>· <TxLink hash={j.txHash} /></>}</p>
                      {j.lastError && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{j.lastError}</p>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-3" aria-busy="true" aria-label="Checking service"><Skeleton className="h-6 w-64" /><Skeleton className="h-20" /></div>
        )}
      </Card>
    </div>
  );
}
