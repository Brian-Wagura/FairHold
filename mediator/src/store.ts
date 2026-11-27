import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { hashBytes } from "./canonical.ts";

export type EvidenceKind = "evidence" | "terms";

/** One upload of some content, for one escrow, by one party. Each keeps its own metadata. */
export interface UploadRecord {
  escrowId: string; // canonical decimal string (no leading zeros)
  uploader: Address;
  kind: EvidenceKind;
  name: string;
  mimeType: string;
  uploadedAt: string;
}

/**
 * Content-addressed record: the bytes are shared by every upload of the same content, while
 * kind, name and mimeType belong to each upload (see `findUpload`).
 */
export interface EvidenceMeta {
  contentHash: Hex;
  size: number;
  uploadedAt: string;
  uploads: UploadRecord[];
}

// "blocked": the session key is not authorized right now (expired, revoked, out of budget, or the
// mediator is paused). Retried while the proposal window is open, so renewing the key resumes it.
export type JobStatus = "pending" | "deciding" | "blocked" | "submitting" | "submitted" | "skipped" | "failed";

export interface Job {
  escrowId: string;
  status: JobStatus;
  attempts: number;
  nextAttemptAt?: number;
  reasoningHash?: Hex;
  payeeAmount?: string;
  txHash?: Hex;
  lastError?: string;
  updatedAt: string;
}

const HASH_RE = /^0x[0-9a-f]{64}$/;

/**
 * Local content-addressed store. Every read re-hashes the bytes, so a file modified on disk
 * after upload is detected and refused rather than shown to the model.
 */
export class Store {
  private jobs = new Map<string, Job>();
  // Per-content-hash write queue: same-hash updates run one after another, others in parallel.
  private locks = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(join(this.dir, "evidence"), { recursive: true });
    await mkdir(join(this.dir, "reasoning"), { recursive: true });
    const jobsFile = join(this.dir, "jobs.json");
    if (existsSync(jobsFile)) {
      const list = JSON.parse(await readFile(jobsFile, "utf8")) as Job[];
      for (const j of list) this.jobs.set(j.escrowId, j);
    }
  }

  // ------------------------------------------------------------------ evidence

  async putEvidence(
    bytes: Uint8Array,
    meta: { kind: EvidenceKind; name: string; mimeType: string },
    upload: { escrowId: string; uploader: Address },
  ): Promise<EvidenceMeta> {
    const contentHash = hashBytes(bytes).toLowerCase() as Hex;
    return this.withLock(contentHash, async () => {
      const existing = await this.getMeta(contentHash);
      const now = new Date().toISOString();
      const record: EvidenceMeta = existing ?? { contentHash, size: bytes.byteLength, uploadedAt: now, uploads: [] };
      const entry: UploadRecord = { escrowId: upload.escrowId, uploader: upload.uploader, ...meta, uploadedAt: now };
      // One record per (escrow, uploader, kind); a re-upload refreshes its own metadata only.
      const i = record.uploads.findIndex(
        (u) => u.escrowId === entry.escrowId && sameAddress(u.uploader, entry.uploader) && u.kind === entry.kind,
      );
      if (i >= 0) record.uploads[i] = entry;
      else record.uploads.push(entry);
      if (!existing || !existsSync(this.blobPath(contentHash))) await atomicWrite(this.blobPath(contentHash), bytes);
      await atomicWrite(this.metaPath(contentHash), JSON.stringify(record, null, 2));
      return record;
    });
  }

  async getMeta(hash: Hex): Promise<EvidenceMeta | undefined> {
    const h = normalizeHash(hash);
    const p = this.metaPath(h);
    if (!existsSync(p)) return undefined;
    return normalizeMeta(JSON.parse(await readFile(p, "utf8")));
  }

  /** Returns the bytes only if they still hash to `hash`. */
  async getVerifiedEvidence(hash: Hex): Promise<{ bytes: Uint8Array; meta: EvidenceMeta } | undefined> {
    const h = normalizeHash(hash);
    const meta = await this.getMeta(h);
    if (!meta || !existsSync(this.blobPath(h))) return undefined;
    const bytes = new Uint8Array(await readFile(this.blobPath(h)));
    if (hashBytes(bytes).toLowerCase() !== h) {
      throw new Error(`integrity failure: stored bytes for ${h} no longer match their hash`);
    }
    return { bytes, meta };
  }

  // ------------------------------------------------------------------ reasoning

  async putReasoning(hash: Hex, json: string): Promise<void> {
    await atomicWrite(join(this.dir, "reasoning", `${normalizeHash(hash)}.json`), json);
  }

  async getReasoning(hash: Hex): Promise<string | undefined> {
    const p = join(this.dir, "reasoning", `${normalizeHash(hash)}.json`);
    return existsSync(p) ? readFile(p, "utf8") : undefined;
  }

  // ------------------------------------------------------------------ jobs

  getJob(escrowId: string): Job | undefined {
    return this.jobs.get(escrowId);
  }

  listJobs(): Job[] {
    return [...this.jobs.values()].sort((a, b) => Number(BigInt(b.escrowId) - BigInt(a.escrowId)));
  }

  async saveJob(job: Omit<Job, "updatedAt">): Promise<Job> {
    const full = { ...job, updatedAt: new Date().toISOString() };
    this.jobs.set(job.escrowId, full);
    await atomicWrite(join(this.dir, "jobs.json"), JSON.stringify(this.listJobs(), null, 2));
    return full;
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private blobPath(h: string) {
    return join(this.dir, "evidence", `${h}.bin`);
  }
  private metaPath(h: string) {
    return join(this.dir, "evidence", `${h}.json`);
  }
}

/**
 * The upload record that applies to a lookup: same escrow, optionally same uploader and kind.
 * Metadata (kind, name, mimeType) always comes from this record, never from another upload.
 */
export function findUpload(
  meta: EvidenceMeta,
  q: { escrowId: string; uploader?: string; kind?: EvidenceKind },
): UploadRecord | undefined {
  return meta.uploads.find(
    (u) => u.escrowId === q.escrowId && (!q.uploader || sameAddress(u.uploader, q.uploader)) && (!q.kind || u.kind === q.kind),
  );
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Reads metadata written by older versions, which kept kind/name/mimeType once per file. */
function normalizeMeta(raw: Record<string, unknown>): EvidenceMeta {
  const legacy = { kind: (raw.kind as EvidenceKind) ?? "evidence", name: (raw.name as string) ?? "evidence", mimeType: (raw.mimeType as string) ?? "application/octet-stream" };
  const uploads = ((raw.uploads as Partial<UploadRecord>[]) ?? []).map((u) => ({
    escrowId: String(u.escrowId),
    uploader: u.uploader as Address,
    kind: u.kind ?? legacy.kind,
    name: u.name ?? legacy.name,
    mimeType: u.mimeType ?? legacy.mimeType,
    uploadedAt: u.uploadedAt ?? (raw.uploadedAt as string),
  }));
  return { contentHash: raw.contentHash as Hex, size: raw.size as number, uploadedAt: raw.uploadedAt as string, uploads };
}

export function normalizeHash(hash: string): Hex {
  const h = hash.toLowerCase();
  if (!HASH_RE.test(h)) throw new Error("invalid bytes32 hash");
  return h as Hex;
}

async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

// ------------------------------------------------------------------ deployment namespacing

/** The on-chain deployment a store belongs to. Escrow ids are only unique per deployment. */
export interface Deployment {
  chainId: number;
  escrow: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Stable directory name for a deployment: `<chainId>-<lowercase escrow address>`. */
export function deploymentNamespace(d: Deployment): string {
  if (!Number.isInteger(d.chainId) || d.chainId <= 0) throw new Error("invalid chain id");
  if (!ADDRESS_RE.test(d.escrow)) throw new Error("invalid escrow address");
  return `${d.chainId}-${d.escrow.toLowerCase()}`;
}

/**
 * Opens the store for one deployment under `<baseDir>/deployments/<chainId>-<escrow>/`.
 *
 * Job state, uploads and reasoning are keyed by escrow id, which restarts at 1 for every new
 * contract. Without a namespace, redeploying the escrow or switching chains would make the
 * worker treat a new escrow #1 as already handled and attribute old uploads to it.
 *
 * A `deployment.json` marker records the owner. A marker for a different deployment is a hard
 * error. Data written by older versions directly in `baseDir` has no owner record, so it is
 * never migrated automatically: it stays where it is, and `legacyDataAt` reports it.
 */
export async function openDeploymentStore(
  baseDir: string,
  d: Deployment,
): Promise<{ store: Store; dir: string; legacyDataAt?: string }> {
  const namespace = deploymentNamespace(d);
  const dir = join(baseDir, "deployments", namespace);
  await mkdir(dir, { recursive: true });

  const owner = { chainId: d.chainId, escrow: d.escrow.toLowerCase() };
  const markerPath = join(dir, "deployment.json");
  if (existsSync(markerPath)) {
    const existing = JSON.parse(await readFile(markerPath, "utf8")) as Partial<Deployment>;
    if (existing.chainId !== owner.chainId || existing.escrow?.toLowerCase() !== owner.escrow) {
      throw new Error(`store at ${dir} belongs to chain ${existing.chainId} escrow ${existing.escrow}, not ${namespace}`);
    }
  } else {
    await atomicWrite(markerPath, JSON.stringify(owner, null, 2));
  }

  const store = new Store(dir);
  await store.init();

  const hasLegacy = ["jobs.json", "evidence", "reasoning"].some((p) => existsSync(join(baseDir, p)));
  return { store, dir, legacyDataAt: hasLegacy ? baseDir : undefined };
}
