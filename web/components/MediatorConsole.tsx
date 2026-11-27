"use client";

import { useCallback, useState } from "react";
import { isAddress, type Abi, type Address, type Hash } from "viem";
import { chainTimeOffsetMs, escrowContract, publicClient } from "@/lib/chain";
import { config } from "@/lib/config";
import { explainError, fmtDate, short } from "@/lib/format";
import { mediatorHealth, mediatorJobs, type Health, type MediatorJob } from "@/lib/mediator-api";
import { IconKey, IconRefresh, IconShield, IconSparkle } from "./icons";
import { useTx } from "./tx";
import { Badge, Button, Card, EmptyState, Field, Notice, PageHeader, Skeleton, TxLink, inputCls, useChainNow, useConfirm, usePoll, type Tone } from "./ui";
import { useWallet } from "./wallet";

type Mediator = Awaited<ReturnType<typeof readMediator>>;
const readMediator = (a: Address) => publicClient.readContract({ ...escrowContract, functionName: "getMediator", args: [a] });

const JOB_TONE: Record<string, Tone> = { submitted: "success", pending: "info", deciding: "ai", blocked: "warn", submitting: "info", failed: "danger", skipped: "neutral" };

export function MediatorConsole() {
  const { address, wallet, connect, connecting } = useWallet();
  const { run } = useTx();
  const confirm = useConfirm();
  const [m, setM] = useState<Mediator>();
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
  const now = useChainNow(0);

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

  const sessionLive = m && m.sessionKey !== "0x0000000000000000000000000000000000000000" && Number(m.sessionExpiry) > now && m.sessionBudget > 0;
  const loadingIdentity = address && loadedFor !== address;
  const keyError = !isAddress(key) ? (key ? "That isn't a valid address." : "Enter the session key address.") : address && key.toLowerCase() === address.toLowerCase() ? "Use a separate key, not this owner wallet." : undefined;
  const daysError = !Number.isInteger(days) || days < 1 || days > 30 ? "Choose 1 to 30 days." : undefined;
  const budgetError = !Number.isInteger(budget) || budget < 1 ? "At least 1 proposal." : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mediator console"
        description={
          <>
            A mediator is an on-chain identity (this wallet, kept cold) that delegates to an AI service through a <strong>session key</strong>. The key can only submit proposals, expires, has a hard proposal budget, and can be revoked instantly. Reputation is computed by the contract from real outcomes.
          </>
        }
      />
      {err && <Notice tone="error" title="That didn't go through">{err}</Notice>}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Identity & reputation" description="Counted by the escrow contract from real outcomes, so it can't be self-reported.">
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

        <Card title={<span className="flex items-center gap-2"><IconKey className="text-gray-500 dark:text-gray-400" /> AI session key</span>} description="A limited key for the AI service. It can never move funds.">
          {m?.registered ? (
            <div className="space-y-5 text-sm">
              {sessionLive ? (
                <Notice tone="success" title={`Active key ${short(m.sessionKey)}`}>
                  {m.sessionBudget} proposal{m.sessionBudget === 1 ? "" : "s"} left · expires {fmtDate(m.sessionExpiry)}
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
                <Field label="Valid for (days)" hint="Up to 30 days." error={daysError}>
                  <input type="number" min={1} max={30} inputMode="numeric" className={inputCls} value={days} onChange={(x) => setDays(Number(x.target.value))} />
                </Field>
                <Field label="Proposal budget" hint="Hard cap on proposals this key can make." error={budgetError}>
                  <input type="number" min={1} inputMode="numeric" className={inputCls} value={budget} onChange={(x) => setBudget(Number(x.target.value))} />
                </Field>
              </div>
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
          ) : (
            <EmptyState icon={<IconKey size={20} />} title="Register first" body="Session keys belong to a registered mediator identity." />
          )}
        </Card>
      </div>

      <Card
        title={<span className="flex items-center gap-2"><IconSparkle className="text-gray-500 dark:text-gray-400" /> Mediator service</span>}
        description={<span className="font-mono text-xs">{config.mediatorApi}</span>}
        action={<Button size="sm" variant="ghost" onClick={() => void load()} aria-label="Refresh service status"><IconRefresh size={14} /> Refresh</Button>}
      >
        {svcErr ? (
          <Notice tone="warn" title="Service unreachable">{svcErr}</Notice>
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
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-gray-100 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
                      <tr><th scope="col" className="py-2 font-medium">Escrow</th><th scope="col" className="font-medium">Status</th><th scope="col" className="font-medium">Attempts</th><th scope="col" className="font-medium">Transaction</th><th scope="col" className="font-medium">Note</th></tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {jobs.map((j) => (
                        <tr key={j.escrowId}>
                          <td className="py-2.5"><a className="font-medium text-gray-900 dark:text-white underline-offset-4 hover:underline" href={`#/escrow/${j.escrowId}`}>#{j.escrowId}</a></td>
                          <td><Badge tone={JOB_TONE[j.status] ?? "neutral"}>{j.status}</Badge></td>
                          <td className="tabular-nums">{j.attempts}</td>
                          <td>{j.txHash ? <TxLink hash={j.txHash} /> : <span className="text-gray-500 dark:text-gray-400">–</span>}</td>
                          <td className="max-w-64 truncate text-xs text-gray-500 dark:text-gray-400" title={j.lastError}>{j.lastError ?? ""}</td>
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
                        <Badge tone={JOB_TONE[j.status] ?? "neutral"}>{j.status}</Badge>
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
