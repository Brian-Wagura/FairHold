"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits, isAddress, keccak256, parseEventLogs, toBytes, type Address, type Hex } from "viem";
import { mediatedEscrowAbi } from "@/lib/abi";
import { chainTimeOffsetMs, escrowContract, publicClient, tokenContract } from "@/lib/chain";
import { config } from "@/lib/config";
import { explainError, fmtAmount, fmtDuration, parseAmount, pct, short } from "@/lib/format";
import { uploadEvidence } from "@/lib/mediator-api";
import { IconLock, IconShield } from "./icons";
import { useTx } from "./tx";
import { Badge, Button, Card, Field, Notice, PageHeader, ProgressSteps, Skeleton, SplitBar, cx, inputCls, type StepState } from "./ui";
import { useWallet } from "./wallet";

const UNITS = { minutes: 60, hours: 3600, days: 86400 } as const;
type Unit = keyof typeof UNITS;
type Win = { n: number; unit: Unit };

interface Preset {
  name: string;
  blurb: string;
  acceptWithin: Win;
  active: Win;
  evidence: Win;
  propose: Win;
  response: Win;
  undisputedBps: number;
  fallbackBps: number;
  terms: string;
}

const PRESETS: Preset[] = [
  {
    name: "Freelance milestone",
    blurb: "Pays the freelancer automatically unless the client disputes in time.",
    acceptWithin: { n: 2, unit: "days" },
    active: { n: 14, unit: "days" },
    evidence: { n: 3, unit: "days" },
    propose: { n: 2, unit: "days" },
    response: { n: 2, unit: "days" },
    undisputedBps: 10_000,
    fallbackBps: 5_000,
    terms: "Milestone 1: brand logo.\nDeliverables: 3 initial concepts, 2 revision rounds, final files as SVG and PNG.\nDeadline: 10 days after acceptance.",
  },
  {
    name: "Rental deposit",
    blurb: "Returns the deposit to the tenant (payer) unless the landlord disputes damage.",
    acceptWithin: { n: 3, unit: "days" },
    active: { n: 180, unit: "days" },
    evidence: { n: 7, unit: "days" },
    propose: { n: 3, unit: "days" },
    response: { n: 3, unit: "days" },
    undisputedBps: 0,
    fallbackBps: 2_500,
    terms: "Security deposit for Flat 4B, 12 Harbour Road.\nReturned in full at move-out unless there is damage beyond normal wear, documented with photos at check-in and check-out.",
  },
  {
    name: "Live demo (minutes)",
    blurb: "Short windows so the whole dispute flow fits in a demo.",
    acceptWithin: { n: 30, unit: "minutes" },
    active: { n: 15, unit: "minutes" },
    evidence: { n: 2, unit: "minutes" },
    propose: { n: 10, unit: "minutes" },
    response: { n: 5, unit: "minutes" },
    undisputedBps: 10_000,
    fallbackBps: 5_000,
    terms: "Website landing page.\nDeliverables: responsive homepage (desktop + mobile), contact form that emails the owner, deployed to a public URL.\nPrice: 100 tUSD8.",
  },
];

const secs = (w: Win) => w.n * UNITS[w.unit];
const MAX_WINDOW = 365 * 86400;

interface MediatorOption {
  address: Address;
  uri: string;
  active: boolean;
  proposals: number;
  accepted: number;
  unchallenged: number;
  rejected: number;
  missed: number;
}

type WinKey = "acceptWithin" | "active" | "evidence" | "propose" | "response";
type Progress = { permit: StepState; approve: StepState; create: StepState; share: StepState };
const IDLE: Progress = { permit: "todo", approve: "skipped", create: "todo", share: "todo" };

export function CreateEscrow({ onCreated }: { onCreated: (id: bigint) => void }) {
  const { address, wallet, tokenBalance, gasBalance, refreshBalances } = useWallet();
  const { run } = useTx();
  const [preset, setPreset] = useState(0);
  const p = PRESETS[preset]!;
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("100");
  const [terms, setTerms] = useState(p.terms);
  const [win, setWin] = useState<Record<WinKey, Win>>({ acceptWithin: p.acceptWithin, active: p.active, evidence: p.evidence, propose: p.propose, response: p.response });
  const [undisputedBps, setUndisputed] = useState(p.undisputedBps);
  const [fallbackBps, setFallback] = useState(p.fallbackBps);
  const [mediators, setMediators] = useState<MediatorOption[]>();
  const [mediator, setMediator] = useState<string>(config.defaultMediator);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress>(IDLE);
  const [error, setError] = useState<string>();
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [attempted, setAttempted] = useState(false);
  const touch = (k: string) => setTouched((t) => ({ ...t, [k]: true }));
  const step = (patch: Partial<Progress>) => setProgress((pr) => ({ ...pr, ...patch }));

  function applyPreset(i: number) {
    const n = PRESETS[i]!;
    setPreset(i);
    setTerms(n.terms);
    setWin({ acceptWithin: n.acceptWithin, active: n.active, evidence: n.evidence, propose: n.propose, response: n.response });
    setUndisputed(n.undisputedBps);
    setFallback(n.fallbackBps);
  }

  useEffect(() => {
    (async () => {
      try {
        const count = await publicClient.readContract({ ...escrowContract, functionName: "mediatorCount" });
        const n = Math.min(Number(count), 20);
        const list: MediatorOption[] = [];
        for (let i = 0; i < n; i++) {
          const a = await publicClient.readContract({ ...escrowContract, functionName: "mediatorAt", args: [BigInt(i)] });
          const m = await publicClient.readContract({ ...escrowContract, functionName: "getMediator", args: [a] });
          list.push({ address: a, uri: m.metadataURI, active: m.active, proposals: m.proposals, accepted: m.accepted, unchallenged: m.unchallenged, rejected: m.rejected, missed: m.missed });
        }
        setMediators(list);
        setMediator((cur) => cur || list.find((m) => m.active)?.address || "");
      } catch {
        setMediators([]);
      }
    })();
  }, []);

  const amountUnits = useMemo(() => {
    try {
      return parseAmount(amount);
    } catch {
      return -1n;
    }
  }, [amount]);

  // ---- validation (same rules as before, now attached to the field they belong to)
  const errors: Record<string, string | undefined> = {};
  if (!isAddress(payee)) errors.payee = payee ? "That isn't a valid wallet address (0x followed by 40 hex characters)." : "Enter the payee's wallet address.";
  else if (address && payee.toLowerCase() === address.toLowerCase()) errors.payee = "The payee must be someone other than you.";
  if (amountUnits <= 0n) errors.amount = amountUnits < 0n ? "Use a plain number, e.g. 250 or 99.50." : "Enter an amount above zero.";
  else if (tokenBalance !== undefined && amountUnits > tokenBalance) errors.amount = `That's more than your balance of ${fmtAmount(tokenBalance)} tUSD8.`;
  if (!isAddress(mediator)) errors.mediator = "Choose a mediator.";
  else if ([address, payee].some((a) => a && a.toLowerCase() === mediator.toLowerCase())) errors.mediator = "The mediator can't be one of the parties.";
  if (terms.trim().length < 10) errors.terms = "Describe what is being paid for (at least a sentence).";
  for (const k of Object.keys(win) as WinKey[]) {
    const s = secs(win[k]);
    if (!Number.isFinite(s) || s < 60) errors[k] = "Must be at least 1 minute.";
    else if (s > MAX_WINDOW) errors[k] = "Must be 365 days or less.";
  }
  const blocking = gasBalance === 0n ? "You need a little tQDAY for gas. Use the faucet." : undefined;
  const show = (k: string) => (attempted || touched[k] ? errors[k] : undefined);
  const errorCount = Object.values(errors).filter(Boolean).length;

  function onSubmitClick() {
    if (errorCount > 0 || blocking) {
      setAttempted(true);
      requestAnimationFrame(() => (document.querySelector<HTMLElement>('[aria-invalid="true"]') ?? document.getElementById("create-error"))?.focus());
      return;
    }
    void submit();
  }

  async function submit() {
    if (!wallet || !address) return;
    setBusy(true);
    setError(undefined);
    setProgress({ ...IDLE, permit: "active" });
    try {
      const offset = await chainTimeOffsetMs();
      const now = BigInt(Math.floor((Date.now() + offset) / 1000));
      const termsHash = keccak256(toBytes(terms));
      const t = {
        payee: payee as Address,
        mediator: mediator as Address,
        amount: amountUnits,
        acceptBy: now + BigInt(secs(win.acceptWithin)),
        activeDuration: BigInt(secs(win.active)),
        evidenceWindow: BigInt(secs(win.evidence)),
        proposeWindow: BigInt(secs(win.propose)),
        responseWindow: BigInt(secs(win.response)),
        undisputedPayeeBps: undisputedBps,
        disputeFallbackPayeeBps: fallbackBps,
        termsHash,
      };

      // Path 1: single transaction with an EIP-2612 permit signature (tUSD8 supports it).
      let receipt = null;
      try {
        const [name, nonce] = await Promise.all([
          publicClient.readContract({ ...tokenContract, functionName: "name" }),
          publicClient.readContract({
            address: config.token,
            abi: [{ type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const,
            functionName: "nonces",
            args: [address],
          }),
        ]);
        const deadline = now + 1800n;
        const sig = await wallet.signTypedData({
          account: address,
          domain: { name, version: "2", chainId: config.chainId, verifyingContract: config.token },
          types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
          primaryType: "Permit",
          message: { owner: address, spender: config.escrow, value: amountUnits, nonce, deadline },
        });
        const r = `0x${sig.slice(2, 66)}` as Hex;
        const s = `0x${sig.slice(66, 130)}` as Hex;
        const v = parseInt(sig.slice(130, 132), 16);
        const call = { ...escrowContract, functionName: "createEscrowWithPermit", args: [t, deadline, v, r, s], account: address } as const;
        await publicClient.simulateContract(call);
        step({ permit: "done", create: "active" });
        receipt = await run("Create & fund escrow", () => wallet.writeContract({ ...call, chain: wallet.chain, type: "legacy" }));
        if (!receipt) throw new Error("create failed");
      } catch (e) {
        if (e instanceof Error && e.message === "create failed") throw new Error("The escrow transaction failed. See the notification for details.");
        // Path 2: classic approve + create (wallets/tokens without permit support).
        step({ permit: "skipped", create: "todo" });
        const allowance = await publicClient.readContract({ ...tokenContract, functionName: "allowance", args: [address, config.escrow] });
        if (allowance < amountUnits) {
          step({ approve: "active" });
          const ok = await run("Approve tUSD8", () =>
            wallet.writeContract({ ...tokenContract, functionName: "approve", args: [config.escrow, amountUnits], account: address, chain: wallet.chain, type: "legacy" }),
          );
          if (!ok) {
            step({ approve: "error" });
            throw new Error("Approval didn't complete, so nothing was escrowed.");
          }
          step({ approve: "done" });
        }
        const call = { ...escrowContract, functionName: "createEscrow", args: [t], account: address } as const;
        await publicClient.simulateContract(call);
        step({ create: "active" });
        receipt = await run("Create & fund escrow", () => wallet.writeContract({ ...call, chain: wallet.chain, type: "legacy" }));
        if (!receipt) throw new Error("The escrow transaction failed. See the notification for details.");
      }
      step({ create: "done", share: "active" });

      const [created] = parseEventLogs({ abi: mediatedEscrowAbi, logs: receipt.logs, eventName: "EscrowCreated" });
      if (!created) throw new Error("Escrow created, but its id couldn't be read from the receipt. Check My escrows.");
      const id = created.args.id;

      // Share the agreement text with the mediator (it is verified against termsHash).
      try {
        await uploadEvidence({ wallet, account: address, escrowId: id, bytes: toBytes(terms), name: "agreement.txt", mimeType: "text/plain", kind: "terms" });
        step({ share: "done" });
      } catch (e) {
        step({ share: "error" });
        console.warn("terms upload failed", e);
      }
      void refreshBalances();
      onCreated(id);
    } catch (e) {
      setError(explainError(e));
      setProgress((pr) => ({
        permit: pr.permit === "active" ? "error" : pr.permit,
        approve: pr.approve === "active" ? "error" : pr.approve,
        create: pr.create === "active" ? "error" : pr.create,
        share: pr.share,
      }));
    } finally {
      setBusy(false);
    }
  }

  const selected = mediators?.find((m) => m.address.toLowerCase() === mediator.toLowerCase());
  const showProgress = busy || progress.permit !== "todo";
  const progressSteps = [
    { label: "Sign spending permit", detail: progress.permit === "skipped" ? "Not available here, so a standard approval is used instead" : "A signature only, no gas", state: progress.permit },
    ...(progress.approve !== "skipped" ? [{ label: "Approve tUSD8", detail: "One-time allowance for this amount", state: progress.approve }] : []),
    { label: "Confirm escrow transaction", detail: "Locks the funds on-chain", state: progress.create },
    { label: "Share agreement with mediator", detail: "Sign to upload the private terms text", state: progress.share },
  ];
  const termsHash = keccak256(toBytes(terms));

  return (
    <div className="space-y-6">
      <PageHeader title="New escrow" description="Lock tUSD8 until the work is done. Nothing moves until you sign, and every outcome is decided by rules you set here." />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <Card title={<SectionTitle n={1}>Start from a template</SectionTitle>} description="Templates fill in sensible deadlines and fallbacks. You can change everything.">
            <fieldset>
              <legend className="sr-only">Template</legend>
              <div className="grid gap-3 sm:grid-cols-3">
                {PRESETS.map((pr, i) => (
                  <label
                    key={pr.name}
                    className={cx(
                      "relative cursor-pointer rounded-xl border bg-white p-4 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-gray-900/20 dark:bg-gray-800 dark:has-[:focus-visible]:ring-gray-100/20",
                      i === preset ? "border-gray-900 ring-1 ring-gray-900 dark:border-gray-100 dark:ring-gray-100" : "border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600",
                    )}
                  >
                    <input type="radio" name="preset" className="sr-only" checked={i === preset} onChange={() => applyPreset(i)} />
                    <span className="block text-sm font-semibold">{pr.name}</span>
                    <span className="mt-1 block text-xs leading-relaxed text-gray-500 dark:text-gray-400">{pr.blurb}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </Card>

          <Card title={<SectionTitle n={2}>Who and how much</SectionTitle>}>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Payee wallet address"
                hint="The person you're paying. They must accept the terms before the deadline."
                error={show("payee")}
                success={!errors.payee && payee ? "Valid address" : undefined}
              >
                <input className={`${inputCls} font-mono`} placeholder="0x…" value={payee} onChange={(e) => setPayee(e.target.value.trim())} onBlur={() => touch("payee")} spellCheck={false} autoComplete="off" />
              </Field>
              <Field label="Amount" hint={tokenBalance !== undefined ? `Available: ${fmtAmount(tokenBalance)} tUSD8` : "Your balance is loading…"} error={show("amount")}>
                {(ctl) => (
                  <div className="relative">
                    <input {...ctl} className={`${inputCls} pr-28 tabular-nums`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={() => touch("amount")} />
                    <div className="absolute inset-y-0 right-2 flex items-center gap-1.5">
                      {tokenBalance !== undefined && tokenBalance > 0n && (
                        <button type="button" onClick={() => { setAmount(formatUnits(tokenBalance, config.tokenDecimals)); touch("amount"); }} className="rounded-lg px-1.5 py-0.5 text-xs font-semibold text-gray-900 transition-colors hover:bg-gray-100 dark:text-white dark:hover:bg-gray-600">
                          Max
                        </button>
                      )}
                      <span className="text-sm font-medium text-gray-500 dark:text-gray-400">tUSD8</span>
                    </div>
                  </div>
                )}
              </Field>
            </div>
            <div className="mt-5">
              <Field
                label="What's being paid for"
                hint={<>Private: only its fingerprint (<span className="font-mono">{short(termsHash)}</span>) goes on-chain. The payee and mediator can read the text. · {terms.length} characters</>}
                error={show("terms")}
              >
                <textarea className={`${inputCls} min-h-32 font-mono text-xs leading-relaxed`} value={terms} onChange={(e) => setTerms(e.target.value)} onBlur={() => touch("terms")} />
              </Field>
            </div>
          </Card>

          <Card title={<SectionTitle n={3}>Choose a mediator</SectionTitle>} description="The mediator can only recommend a split. It never holds funds, and either of you can reject its proposal.">
            {mediators === undefined ? (
              <div className="space-y-2" aria-busy="true" aria-label="Loading mediators">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </div>
            ) : mediators.length === 0 ? (
              <Field label="Mediator address" hint="No mediators were found in the on-chain registry. Paste the address of one you trust." error={show("mediator")}>
                <input className={`${inputCls} font-mono`} value={mediator} onChange={(e) => setMediator(e.target.value.trim())} onBlur={() => touch("mediator")} spellCheck={false} />
              </Field>
            ) : (
              <fieldset aria-describedby={show("mediator") ? "mediator-err" : undefined}>
                <legend className="sr-only">Mediator</legend>
                <div className="space-y-2">
                  {mediators.map((m) => {
                    const decided = m.accepted + m.unchallenged + m.rejected;
                    const rate = decided > 0 ? Math.round(((m.accepted + m.unchallenged) / decided) * 100) : undefined;
                    const checked = m.address.toLowerCase() === mediator.toLowerCase();
                    return (
                      <label
                        key={m.address}
                        className={cx(
                          "flex cursor-pointer items-start gap-3 rounded-xl border bg-white p-4 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-gray-900/20 dark:bg-gray-800 dark:has-[:focus-visible]:ring-gray-100/20",
                          checked ? "border-gray-900 ring-1 ring-gray-900 dark:border-gray-100 dark:ring-gray-100" : "border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600",
                          !m.active && "cursor-not-allowed opacity-60",
                        )}
                      >
                        <input type="radio" name="mediator" className="mt-1 h-4 w-4 accent-primary" disabled={!m.active} checked={checked} onChange={() => setMediator(m.address)} />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm font-semibold">{short(m.address)}</span>
                            {!m.active ? <Badge tone="warn">Paused</Badge> : rate !== undefined ? <Badge tone="success">{rate}% of proposals upheld</Badge> : <Badge>New</Badge>}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-gray-500 dark:text-gray-400">{m.uri}</span>
                          <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                            <span><strong className="tabular-nums text-gray-900 dark:text-white">{m.proposals}</strong> proposals</span>
                            <span><strong className="tabular-nums text-gray-900 dark:text-white">{m.accepted}</strong> accepted</span>
                            <span><strong className="tabular-nums text-gray-900 dark:text-white">{m.unchallenged}</strong> unchallenged</span>
                            <span><strong className="tabular-nums text-gray-900 dark:text-white">{m.rejected}</strong> rejected</span>
                            <span><strong className="tabular-nums text-gray-900 dark:text-white">{m.missed}</strong> missed</span>
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                {show("mediator") && <p id="mediator-err" className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">{show("mediator")}</p>}
              </fieldset>
            )}
          </Card>

          <Card title={<SectionTitle n={4}>Deadlines and fallbacks</SectionTitle>} description="These rules decide the outcome if someone stops responding, so nobody can hold the money hostage.">
            <div className="grid gap-5 sm:grid-cols-2">
              <WindowInput label="Payee must accept within" value={win.acceptWithin} onChange={(v) => setWin({ ...win, acceptWithin: v })} hint="Otherwise you can take a full refund." error={show("acceptWithin")} onBlur={() => touch("acceptWithin")} />
              <WindowInput label="Dispute period after acceptance" value={win.active} onChange={(v) => setWin({ ...win, active: v })} hint="Disputes can be opened until this ends." error={show("active")} onBlur={() => touch("active")} />
              <WindowInput label="Evidence window" value={win.evidence} onChange={(v) => setWin({ ...win, evidence: v })} hint="Time for both sides to add evidence once a dispute opens." error={show("evidence")} onBlur={() => touch("evidence")} />
              <WindowInput label="Mediator must propose within" value={win.propose} onChange={(v) => setWin({ ...win, propose: v })} hint="If it doesn't, the fallback split applies." error={show("propose")} onBlur={() => touch("propose")} />
              <WindowInput label="Time to respond to a proposal" value={win.response} onChange={(v) => setWin({ ...win, response: v })} hint="If nobody rejects, the proposal executes." error={show("response")} onBlur={() => touch("response")} />
            </div>
            <div className="mt-6 grid gap-6 border-t border-gray-100 dark:border-gray-700 pt-6 sm:grid-cols-2">
              <SplitSlider label="If nobody disputes" value={undisputedBps} onChange={setUndisputed} />
              <SplitSlider label="If mediation fails or is rejected" value={fallbackBps} onChange={setFallback} />
            </div>
          </Card>
        </div>

        <aside className="lg:sticky lg:top-24 lg:self-start" aria-label="Review">
          <Card title="Review" tone="highlight">
            <div className="rounded-lg bg-gray-50 dark:bg-gray-900/50 p-4">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">You lock</p>
              <p className="mt-0.5 text-3xl font-semibold tabular-nums tracking-tight">
                {amountUnits > 0n ? fmtAmount(amountUnits) : "0.00"} <span className="text-sm font-medium text-gray-500 dark:text-gray-400">tUSD8</span>
              </p>
            </div>
            <dl className="mt-4 space-y-2.5 text-sm">
              <Row k="Payee" v={isAddress(payee) ? <span className="font-mono">{short(payee)}</span> : <span className="text-gray-500 dark:text-gray-400">Not set</span>} />
              <Row k="Mediator" v={selected ? <span className="font-mono">{short(selected.address)}</span> : isAddress(mediator) ? <span className="font-mono">{short(mediator)}</span> : <span className="text-gray-500 dark:text-gray-400">Not set</span>} />
            </dl>

            <ol className="mt-5 space-y-3 border-l-2 border-gray-100 dark:border-gray-700 pl-4 text-sm" aria-label="Timeline">
              <TimelineItem title="Payee accepts" detail={`within ${fmtDuration(secs(win.acceptWithin))}`} />
              <TimelineItem title="Work and dispute period" detail={fmtDuration(secs(win.active))} />
              <TimelineItem title="If disputed" detail={`${fmtDuration(secs(win.evidence))} evidence → ${fmtDuration(secs(win.propose))} mediator → ${fmtDuration(secs(win.response))} to respond`} />
            </ol>

            <div className="mt-5 space-y-4 text-sm">
              <div>
                <p className="mb-1.5 font-medium">No dispute</p>
                <SplitBar payeeBps={undisputedBps} />
              </div>
              <div>
                <p className="mb-1.5 font-medium">Mediation fails</p>
                <SplitBar payeeBps={fallbackBps} />
              </div>
            </div>

            <ul className="mt-5 space-y-1.5 text-xs text-gray-500 dark:text-gray-400">
              <li className="flex gap-2"><IconShield size={14} className="mt-px shrink-0 text-gray-900 dark:text-white" /> Funds move only by agreement, both of you accepting a proposal, or a deadline passing.</li>
              <li className="flex gap-2"><IconShield size={14} className="mt-px shrink-0 text-gray-900 dark:text-white" /> Anyone can trigger a deadline outcome, so no server has to stay online.</li>
            </ul>

            <div className="mt-5 space-y-3">
              {attempted && (errorCount > 0 || blocking) && (
                <div id="create-error" tabIndex={-1}>
                  <Notice tone="error" title={blocking ?? `Fix ${errorCount} ${errorCount === 1 ? "field" : "fields"} to continue`}>
                    {!blocking && "The problems are highlighted in the form."}
                  </Notice>
                </div>
              )}
              {error && <Notice tone="error" title="Escrow not created">{error}</Notice>}
              {showProgress && (
                <div className="rounded-lg p-4 border" aria-live="polite">
                  <ProgressSteps steps={progressSteps} />
                </div>
              )}
              <Button size="lg" className="w-full" disabled={!wallet} busy={busy} busyLabel="Working… check your wallet" onClick={onSubmitClick}>
                <IconLock /> Lock {amountUnits > 0n ? fmtAmount(amountUnits) : ""} tUSD8
              </Button>
              <p className="text-center text-xs text-gray-500 dark:text-gray-400">Usually one signature and one transaction. You&apos;ll review each in your wallet.</p>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function SectionTitle({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-900 dark:bg-gray-100 text-xs font-bold text-white dark:text-gray-900" aria-hidden>{n}</span>
      {children}
    </span>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-gray-500 dark:text-gray-400">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}

function TimelineItem({ title, detail }: { title: string; detail: string }) {
  return (
    <li className="relative">
      <span className="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full bg-gray-900 dark:bg-gray-100 ring-4 ring-white dark:ring-gray-800" aria-hidden />
      <p className="font-medium">{title}</p>
      <p className="text-xs text-gray-500 dark:text-gray-400">{detail}</p>
    </li>
  );
}

function SplitSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <Field label={<>{label}: payee gets <strong className="tabular-nums">{pct(value)}</strong></>}>
      {(ctl) => (
        <div>
          <input
            {...ctl}
            type="range"
            min={0}
            max={10000}
            step={500}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            aria-valuetext={`Payee ${pct(value)}, payer ${pct(10000 - value)}`}
            className="w-full"
          />
          <div className="mt-1 flex justify-between text-xs text-gray-500 dark:text-gray-400" aria-hidden>
            <span>All to payer</span>
            <span>50/50</span>
            <span>All to payee</span>
          </div>
        </div>
      )}
    </Field>
  );
}

function WindowInput({ label, value, onChange, hint, error, onBlur }: { label: string; value: Win; onChange: (w: Win) => void; hint?: string; error?: string; onBlur?: () => void }) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(ctl) => (
        <div className="flex gap-2">
          <input {...ctl} type="number" min={1} inputMode="numeric" className={`${inputCls} tabular-nums`} value={Number.isFinite(value.n) ? value.n : ""} onChange={(e) => onChange({ ...value, n: Math.max(0, Number(e.target.value)) })} onBlur={onBlur} />
          <select className={`${inputCls} w-32 shrink-0`} aria-label={`${label}: unit`} value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value as Unit })}>
            {Object.keys(UNITS).map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </div>
      )}
    </Field>
  );
}
