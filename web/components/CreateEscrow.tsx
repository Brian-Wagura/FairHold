"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { formatUnits, isAddress, keccak256, parseEventLogs, toBytes, type Address, type Hash, type Hex, type TransactionReceipt } from "viem";
import { mediatedEscrowAbi } from "@/lib/abi";
import { chainTimeOffsetMs, checkTx, escrowContract, publicClient, tokenContract } from "@/lib/chain";
import { config } from "@/lib/config";
import { explainError, fmtAmount, fmtDuration, parseAmount, pct, short } from "@/lib/format";
import { uploadEvidence } from "@/lib/mediator-api";
import { IconCheck, IconLock, IconShield } from "./icons";
import { useTx, type TxOutcome } from "./tx";
import { Badge, Button, Card, Field, Notice, PageHeader, ProgressSteps, Skeleton, SplitBar, TxLink, cx, inputCls, type StepState } from "./ui";
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

const MEDIATOR_PAGE = 20;
const pendingKey = (account: string) => `fairhold:pending-create:${account.toLowerCase()}`;

function readPendingCreate(account?: string): Hash | undefined {
  if (!account || typeof window === "undefined") return undefined;
  try {
    const v = localStorage.getItem(pendingKey(account));
    return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Hash) : undefined;
  } catch {
    return undefined;
  }
}

function writePendingCreate(account: string, hash?: Hash) {
  try {
    if (hash) localStorage.setItem(pendingKey(account), hash);
    else localStorage.removeItem(pendingKey(account));
  } catch {
    /* storage blocked: the in-memory guard still applies */
  }
}

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

type WinKey = "acceptWithin" | "active" | "evidence" | "propose" | "response";
type Progress = { permit: StepState; approve: StepState; create: StepState; share: StepState };
const IDLE: Progress = { permit: "todo", approve: "skipped", create: "todo", share: "todo" };

export function CreateEscrow({ onCreated }: { onCreated: (id: bigint) => void }) {
  const { address, wallet, tokenBalance, gasBalance, refreshBalances } = useWallet();
  const { run, track } = useTx();
  const [preset, setPreset] = useState(0);
  const p = PRESETS[preset]!;
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("100");
  const [terms, setTerms] = useState(p.terms);
  const [win, setWin] = useState<Record<WinKey, Win>>({ acceptWithin: p.acceptWithin, active: p.active, evidence: p.evidence, propose: p.propose, response: p.response });
  const [undisputedBps, setUndisputed] = useState(p.undisputedBps);
  const [fallbackBps, setFallback] = useState(p.fallbackBps);
  const [mediators, setMediators] = useState<MediatorOption[]>();
  const [mediatorTotal, setMediatorTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [manualMediator, setManualMediator] = useState(false);
  const [manualStatus, setManualStatus] = useState<{ address: string; error?: string; checking?: boolean }>();
  const [mediator, setMediator] = useState<string>(config.defaultMediator);
  // A submitted creation whose receipt we couldn't confirm. Persisted so a reload can't double-fund.
  const [unresolved, setUnresolved] = useState<Hash | undefined>(() => readPendingCreate(address));
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string>();
  // Funded escrow whose agreement text didn't reach the mediator yet.
  const [shareRecovery, setShareRecovery] = useState<{ id: bigint; text: string; error: string }>();
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

  async function fetchMediators(from: number, to: number): Promise<MediatorOption[]> {
    const list: MediatorOption[] = [];
    for (let i = from; i < to; i++) {
      const a = await publicClient.readContract({ ...escrowContract, functionName: "mediatorAt", args: [BigInt(i)] });
      const m = await publicClient.readContract({ ...escrowContract, functionName: "getMediator", args: [a] });
      list.push({ address: a, uri: m.metadataURI, active: m.active, proposals: m.proposals, accepted: m.accepted, unchallenged: m.unchallenged, rejected: m.rejected, missed: m.missed });
    }
    return list;
  }

  useEffect(() => {
    (async () => {
      try {
        const count = Number(await publicClient.readContract({ ...escrowContract, functionName: "mediatorCount" }));
        const list = await fetchMediators(0, Math.min(count, MEDIATOR_PAGE));
        setMediatorTotal(count);
        setMediators(list);
        setMediator((cur) => cur || list.find((m) => m.active)?.address || "");
      } catch {
        setMediators([]);
      }
    })();
  }, []);

  async function loadMoreMediators() {
    if (!mediators) return;
    setLoadingMore(true);
    try {
      const more = await fetchMediators(mediators.length, Math.min(mediatorTotal, mediators.length + MEDIATOR_PAGE));
      const all = [...mediators, ...more];
      setMediators(all);
      setMediator((cur) => cur || all.find((m) => m.active)?.address || "");
    } catch {
      /* keep what we have; the button stays available */
    } finally {
      setLoadingMore(false);
    }
  }

  /** Same safeguard as the list: only registered, active mediators can be chosen. */
  async function checkManualMediator(addr: string) {
    if (!isAddress(addr)) return setManualStatus({ address: addr, error: "That isn't a valid wallet address." });
    setManualStatus({ address: addr, checking: true });
    try {
      const m = await publicClient.readContract({ ...escrowContract, functionName: "getMediator", args: [addr as Address] });
      setManualStatus({ address: addr, error: !m.registered ? "This address isn't a registered mediator." : !m.active ? "This mediator is paused and can't take new escrows." : undefined });
    } catch {
      setManualStatus({ address: addr, error: "Couldn't check this mediator. Try again." });
    }
  }

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
  else if (manualMediator && manualStatus?.address === mediator && manualStatus.error) errors.mediator = manualStatus.error;
  else if (manualMediator && (manualStatus?.address !== mediator || manualStatus.checking)) errors.mediator = "Checking this mediator…";
  else if ([address, payee].some((a) => a && a.toLowerCase() === mediator.toLowerCase())) errors.mediator = "The mediator can't be one of the parties.";
  if (terms.trim().length < 10) errors.terms = "Describe what is being paid for (at least a sentence).";
  for (const k of Object.keys(win) as WinKey[]) {
    const s = secs(win[k]);
    if (!Number.isFinite(s) || s < 60) errors[k] = "Must be at least 1 minute.";
    else if (s > MAX_WINDOW) errors[k] = "Must be 365 days or less.";
  }
  const blocking = unresolved
    ? "An earlier escrow transaction hasn't been confirmed yet. Check it below before creating another."
    : shareRecovery
      ? "This escrow is already funded. Finish sharing the agreement below."
      : gasBalance === 0n
        ? "You need a little tQDAY for gas. Use the faucet."
        : undefined;
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
      // Only permit preparation can fall back; once a creation is sent, its outcome is final.
      let outcome: TxOutcome;
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
        outcome = await track("Create & fund escrow", () => wallet.writeContract({ ...call, chain: wallet.chain, type: "legacy" }));
      } catch {
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
        outcome = await track("Create & fund escrow", () => wallet.writeContract({ ...call, chain: wallet.chain, type: "legacy" }));
      }

      if (outcome.status === "not-sent") throw new Error(outcome.error);
      if (outcome.status === "reverted") throw new Error("The escrow transaction reverted, so nothing was escrowed. You can try again.");
      if (outcome.status === "unknown") {
        // It may still land: block another creation until we know.
        writePendingCreate(address, outcome.hash);
        setUnresolved(outcome.hash);
        return;
      }
      await completeCreation(outcome.receipt, terms);
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

  /** After a confirmed creation: read the id, share the agreement, then navigate. */
  async function completeCreation(receipt: TransactionReceipt, text: string) {
    if (address) writePendingCreate(address);
    setUnresolved(undefined);
    step({ create: "done", share: "active" });
    const [created] = parseEventLogs({ abi: mediatedEscrowAbi, logs: receipt.logs, eventName: "EscrowCreated" });
    if (!created) throw new Error("Escrow created, but its id couldn't be read from the receipt. Check My escrows.");
    void refreshBalances();
    await shareAgreement(created.args.id, text);
  }

  /** Uploads the agreement text. On failure, keep the funded escrow and the text for recovery. */
  async function shareAgreement(id: bigint, text: string) {
    if (!wallet || !address) return;
    try {
      await uploadEvidence({ wallet, account: address, escrowId: id, bytes: toBytes(text), name: "agreement.txt", mimeType: "text/plain", kind: "terms" });
      step({ share: "done" });
      setShareRecovery(undefined);
      onCreated(id);
    } catch (e) {
      step({ share: "error" });
      setShareRecovery({ id, text, error: explainError(e) });
    }
  }

  async function recheckCreation() {
    if (!unresolved || !address) return;
    setChecking(true);
    setCheckNote(undefined);
    setError(undefined);
    try {
      const st = await checkTx(unresolved);
      if (st.status === "pending") setCheckNote("Still pending. It hasn't been mined yet; check again in a moment.");
      else if (st.status === "reverted") {
        writePendingCreate(address);
        setUnresolved(undefined);
        setProgress(IDLE);
        setError("That escrow transaction reverted, so nothing was escrowed. You can create the escrow again.");
      } else {
        setBusy(true);
        await completeCreation(st.receipt, terms);
      }
    } catch (e) {
      setCheckNote(explainError(e));
    } finally {
      setChecking(false);
      setBusy(false);
    }
  }

  async function retryShare() {
    if (!shareRecovery) return;
    setBusy(true);
    step({ share: "active" });
    try {
      await shareAgreement(shareRecovery.id, shareRecovery.text);
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
  const windowsOk = (["acceptWithin", "active", "evidence", "propose", "response"] as const).every((k) => !errors[k]);
  const checklist = [
    { label: "Payee and amount", href: "new-parties", ok: !errors.payee && !errors.amount, hint: errors.payee ? "Add payee" : "Check amount" },
    { label: "Agreement", href: "new-parties", ok: !errors.terms, hint: "Describe the work" },
    { label: "Mediator", href: "new-mediator", ok: !errors.mediator, hint: "Choose one" },
    { label: "Deadlines", href: "new-deadlines", ok: windowsOk, hint: "Fix a window" },
  ];
  const readyCount = checklist.filter((c) => c.ok).length;

  return (
    <div className="space-y-6 pb-24 lg:pb-0">
      <PageHeader title="New escrow" description="Lock tUSD8 until the work is done. Nothing moves until you sign, and every outcome is decided by rules you set here." />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <Card id="new-template" title={<SectionTitle n={1}>Start from a template</SectionTitle>} description="Templates fill in sensible deadlines and fallbacks. You can change everything.">
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
                    <span className="flex items-start justify-between gap-2">
                      <span className="block text-sm font-semibold">{pr.name}</span>
                      <span
                        className={cx(
                          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                          i === preset ? "border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900" : "border-gray-300 dark:border-gray-600",
                        )}
                        aria-hidden
                      >
                        {i === preset && <IconCheck size={12} />}
                      </span>
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-gray-500 dark:text-gray-400">{pr.blurb}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </Card>

          <Card id="new-parties" title={<SectionTitle n={2}>Who and how much</SectionTitle>} description="Who you're paying, how much, and what for.">
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

          <Card id="new-mediator" title={<SectionTitle n={3}>Choose a mediator</SectionTitle>} description="The mediator can only recommend a split. It never holds funds, and either of you can reject its proposal.">
            {mediators === undefined ? (
              <div className="space-y-2" aria-busy="true" aria-label="Loading mediators">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </div>
            ) : mediators.length === 0 ? (
              <Field label="Mediator address" hint="No mediators were found in the on-chain registry. Paste the address of one you trust." error={show("mediator")}>
                <input className={`${inputCls} font-mono`} value={mediator} onChange={(e) => { setMediator(e.target.value.trim()); setManualMediator(true); setManualStatus(undefined); }} onBlur={() => { touch("mediator"); setManualMediator(true); void checkManualMediator(mediator); }} spellCheck={false} />
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
                        <input type="radio" name="mediator" className="mt-1 h-4 w-4 accent-primary" disabled={!m.active} checked={checked && !manualMediator} onChange={() => { setManualMediator(false); setMediator(m.address); }} />
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
                {show("mediator") && !manualMediator && <p id="mediator-err" className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">{show("mediator")}</p>}
                {mediators.length < mediatorTotal && (
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Button size="sm" variant="secondary" busy={loadingMore} busyLabel="Loading…" onClick={loadMoreMediators}>
                      Show more mediators ({mediatorTotal - mediators.length} more)
                    </Button>
                    {!mediators.some((m) => m.active) && <span className="text-xs text-gray-500 dark:text-gray-400">All mediators shown so far are paused.</span>}
                  </div>
                )}
              </fieldset>
            )}
            {mediators !== undefined && mediators.length > 0 && (
              <div className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-700">
                {manualMediator ? (
                  <Field label="Mediator address" hint="Paste the address of a registered mediator you trust." error={show("mediator")} success={manualStatus && manualStatus.address === mediator && !manualStatus.error && !manualStatus.checking ? "Registered and accepting escrows" : undefined}>
                    <input
                      className={`${inputCls} font-mono`}
                      value={mediator}
                      onChange={(e) => { setMediator(e.target.value.trim()); setManualStatus(undefined); }}
                      onBlur={() => { touch("mediator"); void checkManualMediator(mediator); }}
                      spellCheck={false}
                    />
                  </Field>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => { setManualMediator(true); setMediator(""); setManualStatus(undefined); }}>
                    Use a different mediator address
                  </Button>
                )}
                {manualMediator && (
                  <Button size="sm" variant="ghost" className="mt-2" onClick={() => { setManualMediator(false); setMediator(mediators.find((m) => m.active)?.address ?? ""); }}>
                    Choose from the list instead
                  </Button>
                )}
              </div>
            )}
          </Card>

          <Card id="new-deadlines" title={<SectionTitle n={4}>Deadlines and fallbacks</SectionTitle>} description="These rules decide the outcome if someone stops responding, so nobody can hold the money hostage.">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Timeline</h3>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Each step starts when the one before it ends.</p>
              <ol className="mt-4 divide-y divide-gray-100 rounded-xl border border-gray-100 dark:divide-gray-700 dark:border-gray-700">
                <TimelineRow n={1} label="Payee accepts within" hint="Otherwise you can take a full refund." value={win.acceptWithin} onChange={(v) => setWin({ ...win, acceptWithin: v })} error={show("acceptWithin")} onBlur={() => touch("acceptWithin")} />
                <TimelineRow n={2} label="Dispute period" hint="After acceptance, either side can open a dispute until this ends." value={win.active} onChange={(v) => setWin({ ...win, active: v })} error={show("active")} onBlur={() => touch("active")} />
                <li className="bg-gray-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:bg-gray-900/40 dark:text-gray-400">Only if someone disputes</li>
                <TimelineRow n={3} label="Evidence window" hint="Both sides add evidence." value={win.evidence} onChange={(v) => setWin({ ...win, evidence: v })} error={show("evidence")} onBlur={() => touch("evidence")} />
                <TimelineRow n={4} label="Mediator decides within" hint="If it misses this, the fallback split applies." value={win.propose} onChange={(v) => setWin({ ...win, propose: v })} error={show("propose")} onBlur={() => touch("propose")} />
                <TimelineRow n={5} label="Time to respond" hint="If nobody rejects the proposal, it executes." value={win.response} onChange={(v) => setWin({ ...win, response: v })} error={show("response")} onBlur={() => touch("response")} />
              </ol>
            </div>
            <div className="mt-8">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Automatic splits</h3>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">What each side receives when a deadline decides the outcome.</p>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <SplitControl title="If nobody disputes" description="Paid out when the dispute period ends." value={undisputedBps} onChange={setUndisputed} amount={amountUnits > 0n ? amountUnits : 0n} />
                <SplitControl title="If mediation fails" description="Used if a proposal is rejected or the mediator misses its deadline." value={fallbackBps} onChange={setFallback} amount={amountUnits > 0n ? amountUnits : 0n} />
              </div>
            </div>
          </Card>
        </div>

        <aside className="lg:sticky lg:top-24 lg:self-start" aria-label="Review">
          <Card id="new-review" title="Review" tone="highlight">
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

            <div className="mt-5 border-t border-gray-100 pt-4 dark:border-gray-700">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {readyCount === checklist.length ? "Ready to lock" : `${readyCount} of ${checklist.length} sections ready`}
              </p>
              <ul className="mt-2 space-y-1">
                {checklist.map((c) => (
                  <li key={c.label}>
                    <a href={`#${c.href}`} onClick={(ev) => { ev.preventDefault(); document.getElementById(c.href)?.scrollIntoView({ behavior: "smooth", block: "start" }); }} className="-mx-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/40">
                      <span
                        className={cx(
                          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                          c.ok ? "border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900" : attempted ? "border-red-500 text-red-600 dark:text-red-400" : "border-gray-300 dark:border-gray-600",
                        )}
                        aria-hidden
                      >
                        {c.ok ? <IconCheck size={12} /> : attempted ? "!" : null}
                      </span>
                      <span className={cx("flex-1", c.ok ? "text-gray-900 dark:text-white" : "text-gray-600 dark:text-gray-300")}>{c.label}</span>
                      <span className="sr-only">{c.ok ? "complete" : "needs attention"}</span>
                      {!c.ok && <span className="text-xs text-gray-500 dark:text-gray-400">{c.hint}</span>}
                    </a>
                  </li>
                ))}
              </ul>
              <p className="mt-3 flex gap-2 text-xs text-gray-500 dark:text-gray-400">
                <IconShield size={14} className="mt-px shrink-0 text-gray-900 dark:text-white" />
                Funds move only by agreement, an accepted proposal, or a deadline anyone can trigger.
              </p>
            </div>

            <div className="mt-5 space-y-3">
              {attempted && (errorCount > 0 || blocking) && (
                <div id="create-error" tabIndex={-1}>
                  <Notice tone="error" title={blocking ?? `Fix ${errorCount} ${errorCount === 1 ? "field" : "fields"} to continue`}>
                    {!blocking && "The problems are highlighted in the form."}
                  </Notice>
                </div>
              )}
              {error && <Notice tone="error" title="Escrow not created">{error}</Notice>}
              {unresolved && (
                <Notice tone="warn" title="Waiting to confirm your escrow transaction">
                  <p>It was submitted but hasn&apos;t been confirmed. It may still go through, so creating another escrow now could lock funds twice.</p>
                  <p className="mt-1"><TxLink hash={unresolved} label="View transaction" /></p>
                  {checkNote && <p className="mt-1">{checkNote}</p>}
                  <Button size="sm" variant="secondary" className="mt-2" busy={checking} busyLabel="Checking…" onClick={recheckCreation}>Check again</Button>
                </Notice>
              )}
              {shareRecovery && (
                <Notice tone="warn" title={`Escrow #${shareRecovery.id} is funded, but the agreement wasn't shared`}>
                  <p>{shareRecovery.error}</p>
                  <p className="mt-1">The payee and mediator need the agreement text. Retry now, and keep a copy in case you need it later.</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" busy={busy} busyLabel="Sharing…" onClick={retryShare}>Retry sharing</Button>
                    <Button size="sm" variant="secondary" onClick={() => downloadText(`escrow-${shareRecovery.id}-agreement.txt`, shareRecovery.text)}>Download agreement</Button>
                    <Button size="sm" variant="ghost" onClick={() => onCreated(shareRecovery.id)}>Continue without sharing</Button>
                  </div>
                </Notice>
              )}
              {showProgress && (
                <div className="rounded-lg p-4 border" aria-live="polite">
                  <ProgressSteps steps={progressSteps} />
                </div>
              )}
              <Button size="lg" className="w-full" disabled={!wallet || Boolean(unresolved) || Boolean(shareRecovery)} busy={busy} busyLabel="Working… check your wallet" onClick={onSubmitClick}>
                <IconLock /> Lock {amountUnits > 0n ? fmtAmount(amountUnits) : ""} tUSD8
              </Button>
              <p className="text-center text-xs text-gray-500 dark:text-gray-400">Usually one signature and one transaction. You&apos;ll review each in your wallet.</p>
            </div>
          </Card>
        </aside>
      </div>

      {/* Phones: keep the amount and the next step in reach while scrolling the long form. */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-100 bg-white/95 px-4 py-3 lg:hidden dark:border-gray-700 dark:bg-gray-900/95">
        <div className="mx-auto flex max-w-page items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-gray-500 dark:text-gray-400">{readyCount === checklist.length ? "Ready to lock" : `${readyCount} of ${checklist.length} ready`}</p>
            <p className="truncate text-base font-bold tabular-nums text-gray-900 dark:text-white">
              {amountUnits > 0n ? fmtAmount(amountUnits) : "0.00"} <span className="text-xs font-medium text-gray-500 dark:text-gray-400">tUSD8</span>
            </p>
          </div>
          <Button onClick={() => document.getElementById("new-review")?.scrollIntoView({ behavior: "smooth", block: "start" })}>Review &amp; lock</Button>
        </div>
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

const UNIT_SHORT: Record<Unit, string> = { minutes: "min", hours: "hr", days: "days" };

/** One step of the deadline timeline: label and explanation, then a duration with unit pills. */
function TimelineRow({ n, label, hint, value, onChange, error, onBlur }: { n: number; label: string; hint: string; value: Win; onChange: (w: Win) => void; error?: string; onBlur?: () => void }) {
  const id = useId();
  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200" aria-hidden>{n}</span>
        <div className="min-w-0">
          <label htmlFor={id} className="text-sm font-medium text-gray-900 dark:text-white">{label}</label>
          <p className="text-xs text-gray-500 dark:text-gray-400">{hint}</p>
          {error && <p id={`${id}-err`} className="mt-1 text-xs font-medium text-red-600 dark:text-red-400">{error}</p>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 pl-9 sm:pl-0">
        <input
          id={id}
          type="number"
          min={1}
          inputMode="numeric"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          className={`${inputCls} w-20 text-center tabular-nums`}
          value={Number.isFinite(value.n) ? value.n : ""}
          onChange={(e) => onChange({ ...value, n: Math.max(0, Number(e.target.value)) })}
          onBlur={onBlur}
        />
        <div role="group" aria-label={`${label}: unit`} className="inline-flex rounded-lg border border-gray-300 bg-white p-0.5 dark:border-gray-600 dark:bg-gray-700">
          {(Object.keys(UNITS) as Unit[]).map((u) => (
            <button
              key={u}
              type="button"
              aria-pressed={value.unit === u}
              onClick={() => onChange({ ...value, unit: u })}
              className={cx(
                "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                value.unit === u ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900" : "text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white",
              )}
            >
              {UNIT_SHORT[u]}
            </button>
          ))}
        </div>
      </div>
    </li>
  );
}

const SPLIT_PRESETS = [0, 2500, 5000, 7500, 10000];

/** Payee/payer split with the real amounts, a slider and quick presets. */
function SplitControl({ title, description, value, onChange, amount }: { title: string; description: string; value: number; onChange: (v: number) => void; amount: bigint }) {
  const id = useId();
  const payee = (amount * BigInt(value)) / 10000n;
  return (
    <div className="rounded-xl border border-gray-100 p-4 dark:border-gray-700">
      <label htmlFor={id} className="text-sm font-semibold text-gray-900 dark:text-white">{title}</label>
      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{description}</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/50">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Payee gets</p>
          <p className="mt-0.5 text-lg font-bold tabular-nums text-gray-900 dark:text-white">{pct(value)}</p>
          <p className="text-xs tabular-nums text-gray-500 dark:text-gray-400">{fmtAmount(payee)} tUSD8</p>
        </div>
        <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/50">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Payer gets back</p>
          <p className="mt-0.5 text-lg font-bold tabular-nums text-gray-900 dark:text-white">{pct(10000 - value)}</p>
          <p className="text-xs tabular-nums text-gray-500 dark:text-gray-400">{fmtAmount(amount - payee)} tUSD8</p>
        </div>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={10000}
        step={500}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={`Payee ${pct(value)}, payer ${pct(10000 - value)}`}
        className="mt-4 h-2 w-full cursor-pointer appearance-none rounded-full bg-gray-200 dark:bg-gray-700 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-gray-900 dark:[&::-moz-range-thumb]:border-gray-800 dark:[&::-moz-range-thumb]:bg-gray-100 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-gray-900 [&::-webkit-slider-thumb]:shadow-sm dark:[&::-webkit-slider-thumb]:border-gray-800 dark:[&::-webkit-slider-thumb]:bg-gray-100"
        style={{ backgroundImage: `linear-gradient(to right, var(--primary) ${value / 100}%, transparent ${value / 100}%)` }}
      />
      <div role="group" aria-label={`${title}: presets`} className="mt-3 flex flex-wrap gap-1.5">
        {SPLIT_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={value === p}
            onClick={() => onChange(p)}
            className={cx(
              "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
              value === p
                ? "border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900"
                : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-600",
            )}
          >
            {p === 0 ? "All to payer" : p === 10000 ? "All to payee" : pct(p)}
          </button>
        ))}
      </div>
    </div>
  );
}
