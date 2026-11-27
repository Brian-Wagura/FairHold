import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { isHex, type Address, type Hex } from "viem";
import { readGrantIsFresh, readMessage, uploadMessage } from "./auth.ts";
import { hashBytes } from "./canonical.ts";
import { escrowContract, readEscrow, Status, type PublicClient } from "./chain.ts";
import type { Config } from "./config.ts";
import { findUpload, normalizeHash, type Store } from "./store.ts";
import type { MediatorWorker } from "./worker.ts";

const UploadBody = z.object({
  escrowId: z.string().regex(/^\d+$/),
  kind: z.enum(["evidence", "terms"]).default("evidence"),
  name: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(100).regex(/^[\w.+-]+\/[\w.+-]+$/),
  contentBase64: z.string().min(1),
  signature: z.string().refine((s) => isHex(s), "signature must be hex"),
});

// Read grants travel in a JSON body (like uploads), never in the URL, so they stay out of logs,
// proxies and browser history.
const ReadBody = z.object({
  escrowId: z.string().regex(/^\d+$/),
  expires: z.coerce.number().int(),
  signature: z.string().refine((s) => isHex(s), "signature must be hex"),
});

export interface ServerDeps {
  cfg: Config;
  publicClient: PublicClient;
  store: Store;
  worker: MediatorWorker;
  sessionKey?: Address;
}

export function buildServer(d: ServerDeps): FastifyInstance {
  const { cfg, publicClient, store } = d;
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // Log method, path and request id only: query strings may carry sensitive values.
      serializers: {
        req: (req: { method: string; url: string; id: string }) => ({ method: req.method, url: req.url.split("?")[0], id: req.id }),
      },
    },
    bodyLimit: Math.ceil(cfg.MAX_EVIDENCE_BYTES * 1.4) + 4096, // base64 overhead
  });

  // Minimal CORS for the configured web origins.
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && (cfg.corsOrigins.includes(origin) || cfg.corsOrigins.includes("*"))) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "origin");
      reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
      reply.header("access-control-allow-headers", "content-type");
    }
    if (req.method === "OPTIONS") return reply.code(204).send();
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "invalid_request", details: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    else app.log.info({ status, msg: (err as Error).message }, "request rejected");
    return reply.code(status).send({ error: status >= 500 ? "internal_error" : (err as Error).message });
  });

  /** Party check against live chain state; accepts EOAs and ERC-1271 smart accounts. */
  async function recoverParty(escrowId: bigint, message: string, signature: Hex) {
    const escrow = await readEscrow(publicClient, cfg.ESCROW_ADDRESS, escrowId).catch(() => undefined);
    if (!escrow) throw httpError(404, "escrow not found");
    for (const candidate of [escrow.payer, escrow.payee] as Address[]) {
      if (await publicClient.verifyMessage({ address: candidate, message, signature })) {
        return { escrow, party: candidate, role: candidate === escrow.payer ? ("payer" as const) : ("payee" as const) };
      }
    }
    throw httpError(403, "signature is not from the payer or payee of this escrow");
  }

  app.get("/health", async () => {
    const mediator = await publicClient
      .readContract({ ...escrowContract(cfg.ESCROW_ADDRESS), functionName: "getMediator", args: [cfg.MEDIATOR_ADDRESS] })
      .catch(() => undefined);
    const canPropose = d.sessionKey
      ? await publicClient
          .readContract({ ...escrowContract(cfg.ESCROW_ADDRESS), functionName: "canPropose", args: [cfg.MEDIATOR_ADDRESS, d.sessionKey] })
          .catch(() => false)
      : false;
    return {
      ok: !d.worker.state.lastTickError,
      chainId: cfg.CHAIN_ID,
      escrow: cfg.ESCROW_ADDRESS,
      mediator: cfg.MEDIATOR_ADDRESS,
      mode: cfg.MEDIATOR_MODE,
      sessionKey: d.sessionKey ?? null,
      sessionKeyCanPropose: canPropose,
      session: mediator
        ? {
            registered: mediator.registered,
            active: mediator.active,
            expiry: Number(mediator.sessionExpiry),
            budget: mediator.sessionBudget,
            stats: {
              proposals: mediator.proposals,
              accepted: mediator.accepted,
              unchallenged: mediator.unchallenged,
              rejected: mediator.rejected,
              missed: mediator.missed,
            },
          }
        : null,
      worker: d.worker.state,
    };
  });

  // Job state only: no evidence content, no keys.
  app.get("/jobs", async () => ({ jobs: store.listJobs() }));

  app.post("/evidence", async (req, reply) => {
    const body = UploadBody.parse(req.body);
    const bytes = new Uint8Array(Buffer.from(body.contentBase64, "base64"));
    if (bytes.byteLength === 0) throw httpError(400, "empty file");
    if (bytes.byteLength > cfg.MAX_EVIDENCE_BYTES) throw httpError(413, `file exceeds ${cfg.MAX_EVIDENCE_BYTES} bytes`);
    const contentHash = hashBytes(bytes);
    const escrowId = BigInt(body.escrowId);
    const escrowKey = escrowId.toString(); // canonical: "007" and "7" are the same escrow
    const message = uploadMessage({ chainId: cfg.CHAIN_ID, escrow: cfg.ESCROW_ADDRESS, escrowId, contentHash, kind: body.kind });
    const { escrow, party, role } = await recoverParty(escrowId, message, body.signature as Hex);

    if (body.kind === "terms") {
      if (role !== "payer") throw httpError(403, "only the payer uploads the agreement text");
      if (contentHash.toLowerCase() !== escrow.termsHash.toLowerCase()) throw httpError(400, "file does not match the escrow's on-chain termsHash");
    } else if (escrow.status !== Status.Active && escrow.status !== Status.Disputed) {
      throw httpError(409, "evidence can only be added while the escrow is active or disputed");
    }

    const meta = await store.putEvidence(bytes, { kind: body.kind, name: body.name, mimeType: body.mimeType }, { escrowId: escrowKey, uploader: party });
    return reply.code(201).send({ contentHash: meta.contentHash, uri: `fairhold://evidence/${meta.contentHash}`, size: meta.size });
  });

  app.post<{ Params: { hash: string } }>("/evidence/:hash/read", async (req, reply) => {
    const hash = safeHash(req.params.hash);
    const q = ReadBody.parse(req.body);
    if (!readGrantIsFresh(q.expires)) throw httpError(401, "access grant expired or too long-lived");
    const escrowId = BigInt(q.escrowId);
    const escrowKey = escrowId.toString();
    await recoverParty(escrowId, readMessage({ chainId: cfg.CHAIN_ID, escrow: cfg.ESCROW_ADDRESS, escrowId, expires: q.expires }), q.signature as Hex);
    const found = await store.getVerifiedEvidence(hash).catch(() => undefined);
    const upload = found && findUpload(found.meta, { escrowId: escrowKey });
    if (!found || !upload) throw httpError(404, "evidence not found for this escrow");
    return reply
      .header("content-type", upload.mimeType)
      .header("content-disposition", `inline; filename="${upload.name.replace(/[^\w.-]/g, "_")}"`)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, no-store")
      .send(Buffer.from(found.bytes));
  });

  // The mediator's committed rationale. Anyone can recompute keccak256(body) and compare
  // with the reasoningHash stored on-chain.
  app.get<{ Params: { hash: string } }>("/reasoning/:hash", async (req, reply) => {
    const json = await store.getReasoning(safeHash(req.params.hash));
    if (!json) throw httpError(404, "reasoning not found");
    return reply.header("content-type", "application/json; charset=utf-8").send(json);
  });

  return app;
}

function safeHash(h: string): Hex {
  try {
    return normalizeHash(h);
  } catch {
    throw httpError(400, "invalid hash");
  }
}

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}
