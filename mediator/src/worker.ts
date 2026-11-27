import { BaseError, ContractFunctionRevertedError, erc20Abi, type Address, type Hex } from "viem";
import { bpsOf, hashJson } from "./canonical.ts";
import { chainNow, escrowContract, readEscrow, Status, type EscrowView, type PublicClient, type WalletClient } from "./chain.ts";
import type { Config } from "./config.ts";
import type { DecisionEngine, DisputeContext, EvidenceItem } from "./policy.ts";
import type { Job, Store } from "./store.ts";

export interface WorkerDeps {
  cfg: Config;
  publicClient: PublicClient;
  walletClient?: WalletClient;
  store: Store;
  engine: DecisionEngine;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface WorkerState {
  running: boolean;
  lastTickAt?: string;
  lastTickError?: string;
  lastBlockTime?: string;
  scanned: number;
}

/**
 * Polls the escrow contract and submits at most one proposal per disputed escrow.
 * Liveness is *not* required for safety: if this worker is down, the contract's
 * mediator-timeout fallback settles the dispute.
 */
export class MediatorWorker {
  readonly state: WorkerState = { running: false, scanned: 0 };
  private inFlight = false;
  private decimals = 6;

  constructor(private readonly d: WorkerDeps) {}

  async start(signal: AbortSignal): Promise<void> {
    this.state.running = true;
    try {
      this.decimals = await this.d.publicClient.readContract({
        address: await this.tokenAddress(),
        abi: erc20Abi,
        functionName: "decimals",
      });
    } catch {
      /* default 6 */
    }
    while (!signal.aborted) {
      await this.tick();
      await sleep(this.d.cfg.POLL_INTERVAL_MS, signal);
    }
    this.state.running = false;
  }

  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const { publicClient, cfg } = this.d;
      const ids = await publicClient.readContract({
        ...escrowContract(cfg.ESCROW_ADDRESS),
        functionName: "escrowsOf",
        args: [cfg.MEDIATOR_ADDRESS],
      });
      const now = await chainNow(publicClient);
      this.state.lastBlockTime = new Date(Number(now) * 1000).toISOString();
      this.state.scanned = ids.length;
      for (const id of ids) {
        const job = this.d.store.getJob(id.toString());
        if (job && (job.status === "submitted" || job.status === "skipped" || job.status === "failed")) continue;
        if (job?.nextAttemptAt && Date.now() < job.nextAttemptAt) continue;
        const escrow = await readEscrow(publicClient, cfg.ESCROW_ADDRESS, id);
        if (escrow.status !== Status.Disputed) {
          if (job && escrow.status !== Status.Disputed) await this.closeIfResolved(id, escrow, job);
          continue;
        }
        if (now < escrow.evidenceDeadline) continue; // evidence window still open
        if (now >= escrow.proposeDeadline) {
          await this.d.store.saveJob({ ...(job ?? baseJob(id)), status: "skipped", lastError: "propose deadline passed; contract fallback applies" });
          continue;
        }
        await this.handle(id, escrow, job);
      }
      this.state.lastTickAt = new Date().toISOString();
      this.state.lastTickError = undefined;
    } catch (err) {
      this.state.lastTickError = errorMessage(err);
      this.d.log("tick failed", { error: this.state.lastTickError });
    } finally {
      this.inFlight = false;
    }
  }

  private async closeIfResolved(id: bigint, escrow: EscrowView, job: Job) {
    if (escrow.status === Status.Proposed && job.status !== "submitted") {
      // A previous submission landed even though we lost the receipt.
      await this.d.store.saveJob({ ...job, status: "submitted" });
    }
  }

  async handle(id: bigint, escrow: EscrowView, existing?: Job): Promise<void> {
    const { cfg, store, log } = this.d;
    let job: Omit<Job, "updatedAt"> = existing ?? baseJob(id);

    if (!this.d.walletClient) {
      log("dispute ready but no SESSION_KEY_PRIVATE_KEY configured", { escrowId: id.toString() });
      return;
    }

    try {
      // 1. Decide once. Re-use a stored decision on retries so the commitment stays stable.
      if (!job.reasoningHash || !job.payeeAmount) {
        job = await store.saveJob({ ...job, status: "deciding" });
        const ctx = await this.buildContext(id, escrow);
        const { decision, engine } = await this.d.engine.decide(ctx);
        const payeeAmount = bpsOf(escrow.amount, decision.payee_share_bps);
        const doc = {
          schema: "fairhold.reasoning.v1",
          escrow: { chainId: cfg.CHAIN_ID, contract: cfg.ESCROW_ADDRESS.toLowerCase(), id: id.toString() },
          mediator: cfg.MEDIATOR_ADDRESS.toLowerCase(),
          engine,
          amount: escrow.amount.toString(),
          payeeAmount: payeeAmount.toString(),
          decision,
          evidence: ctx.evidence.map((e) => ({ index: e.index, party: e.party, contentHash: e.contentHash, status: e.status })),
          termsVerified: Boolean(ctx.termsText),
          decidedAt: new Date().toISOString(),
        };
        const { json, hash } = hashJson(doc);
        await store.putReasoning(hash, json);
        job = await store.saveJob({ ...job, reasoningHash: hash, payeeAmount: payeeAmount.toString() });
        log("decision ready", { escrowId: id.toString(), bps: decision.payee_share_bps, reasoningHash: hash });
      }

      // 2. Re-validate on-chain state immediately before proposing.
      const fresh = await readEscrow(this.d.publicClient, cfg.ESCROW_ADDRESS, id);
      const now = await chainNow(this.d.publicClient);
      if (fresh.status !== Status.Disputed) {
        await store.saveJob({ ...job, status: fresh.status === Status.Proposed ? "submitted" : "skipped" });
        return;
      }
      if (now < fresh.evidenceDeadline || now >= fresh.proposeDeadline) return;
      const payeeAmount = BigInt(job.payeeAmount!);
      if (payeeAmount > fresh.amount) throw new Error("payee amount exceeds escrow (refusing to submit)");

      // 3. Simulate, then submit with the scoped session key (legacy tx: Aevum has no EIP-1559).
      job = await store.saveJob({ ...job, status: "submitting" });
      const call = {
        ...escrowContract(cfg.ESCROW_ADDRESS),
        functionName: "propose",
        args: [id, payeeAmount, job.reasoningHash as Hex],
        account: this.d.walletClient.account,
      } as const;
      await this.d.publicClient.simulateContract(call); // surfaces revert reasons before spending gas
      const txHash = await this.d.walletClient.writeContract({ ...call, type: "legacy", chain: this.d.walletClient.chain });
      job = await store.saveJob({ ...job, txHash });
      const receipt = await this.d.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(`propose tx reverted: ${txHash}`);
      await store.saveJob({ ...job, status: "submitted", lastError: undefined });
      log("proposal submitted", { escrowId: id.toString(), txHash, explorer: `${cfg.EXPLORER_URL}/tx/${txHash}` });
    } catch (err) {
      const attempts = job.attempts + 1;
      const permanent = isPermanent(err) || attempts >= cfg.MAX_SUBMIT_ATTEMPTS;
      const backoff = Math.min(10 * 60_000, 2 ** attempts * 5_000);
      await store.saveJob({
        ...job,
        attempts,
        status: permanent ? "failed" : "pending",
        nextAttemptAt: permanent ? undefined : Date.now() + backoff,
        lastError: errorMessage(err),
      });
      log("proposal attempt failed", { escrowId: id.toString(), attempts, permanent, error: errorMessage(err) });
    }
  }

  async buildContext(id: bigint, escrow: EscrowView): Promise<DisputeContext> {
    const { publicClient, cfg, store } = this.d;
    const onchain = await publicClient.readContract({
      ...escrowContract(cfg.ESCROW_ADDRESS),
      functionName: "getEvidence",
      args: [id],
    });
    const partyOf = (a: Address): "payer" | "payee" =>
      a.toLowerCase() === escrow.payer.toLowerCase() ? "payer" : "payee";

    const evidence: EvidenceItem[] = [];
    for (const [index, e] of onchain.entries()) {
      const base = { index, party: partyOf(e.submitter), submittedAt: Number(e.submittedAt), contentHash: e.contentHash };
      try {
        const found = await store.getVerifiedEvidence(e.contentHash);
        // Only content uploaded *for this escrow by this submitter* is considered.
        const linked = found?.meta.uploads.some(
          (u) => u.escrowId === id.toString() && u.uploader.toLowerCase() === e.submitter.toLowerCase(),
        );
        if (!found || !linked) evidence.push({ ...base, status: "missing" });
        else if (found.bytes.byteLength > cfg.MAX_EVIDENCE_BYTES) evidence.push({ ...base, status: "unsupported" });
        else evidence.push({ ...base, status: "verified", name: found.meta.name, mimeType: found.meta.mimeType, bytes: found.bytes });
      } catch {
        evidence.push({ ...base, status: "integrity_failure" });
      }
    }

    let termsText: string | undefined;
    try {
      const terms = await store.getVerifiedEvidence(escrow.termsHash);
      if (terms && terms.meta.kind === "terms") termsText = new TextDecoder().decode(terms.bytes);
    } catch {
      /* terms unavailable */
    }

    return {
      chainId: cfg.CHAIN_ID,
      escrow: cfg.ESCROW_ADDRESS,
      escrowId: id.toString(),
      amount: escrow.amount,
      decimals: this.decimals,
      disputedBy: partyOf(escrow.disputedBy),
      undisputedPayeeBps: escrow.undisputedPayeeBps,
      disputeFallbackPayeeBps: escrow.disputeFallbackPayeeBps,
      termsHash: escrow.termsHash,
      termsText,
      evidence,
    };
  }

  private async tokenAddress(): Promise<Address> {
    return this.d.publicClient.readContract({ ...escrowContract(this.d.cfg.ESCROW_ADDRESS), functionName: "token" });
  }
}

function baseJob(id: bigint): Omit<Job, "updatedAt"> {
  return { escrowId: id.toString(), status: "pending", attempts: 0 };
}

function isPermanent(err: unknown): boolean {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      // Wrong status / authorization / deadline: retrying will not help.
      return ["WrongStatus", "NotAuthorizedMediator", "DeadlinePassed", "AmountExceedsEscrow"].includes(
        revert.data?.errorName ?? "",
      );
    }
  }
  return false;
}

export function errorMessage(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage;
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
