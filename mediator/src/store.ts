import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { hashBytes } from "./canonical.ts";

export interface EvidenceMeta {
  contentHash: Hex;
  kind: "evidence" | "terms";
  name: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
  // (escrowId -> uploader) pairs this content was uploaded for.
  uploads: { escrowId: string; uploader: Address }[];
}

export type JobStatus = "pending" | "deciding" | "submitting" | "submitted" | "skipped" | "failed";

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
    meta: Omit<EvidenceMeta, "contentHash" | "size" | "uploadedAt" | "uploads">,
    upload: { escrowId: string; uploader: Address },
  ): Promise<EvidenceMeta> {
    const contentHash = hashBytes(bytes).toLowerCase() as Hex;
    const existing = await this.getMeta(contentHash);
    const record: EvidenceMeta = existing ?? {
      contentHash,
      ...meta,
      size: bytes.byteLength,
      uploadedAt: new Date().toISOString(),
      uploads: [],
    };
    if (!record.uploads.some((u) => u.escrowId === upload.escrowId && u.uploader === upload.uploader)) {
      record.uploads.push(upload);
    }
    if (!existing) await atomicWrite(this.blobPath(contentHash), bytes);
    await atomicWrite(this.metaPath(contentHash), JSON.stringify(record, null, 2));
    return record;
  }

  async getMeta(hash: Hex): Promise<EvidenceMeta | undefined> {
    const h = normalizeHash(hash);
    const p = this.metaPath(h);
    if (!existsSync(p)) return undefined;
    return JSON.parse(await readFile(p, "utf8")) as EvidenceMeta;
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

  private blobPath(h: string) {
    return join(this.dir, "evidence", `${h}.bin`);
  }
  private metaPath(h: string) {
    return join(this.dir, "evidence", `${h}.json`);
  }
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
