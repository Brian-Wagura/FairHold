/**
 * End-to-end: real contracts on a local anvil (Shanghai, like Aevum), real HTTP routes,
 * real worker, stubbed decision engine. Skips when anvil or forge artifacts are missing.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mediatedEscrowAbi } from "../src/abi.ts";
import { uploadMessage } from "../src/auth.ts";
import { aevumChain } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import type { DecisionEngine, DisputeContext } from "../src/policy.ts";
import { buildServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { MediatorWorker } from "../src/worker.ts";

const OUT = join(import.meta.dirname, "../../contracts/out");
const PORT = 8599;
const RPC = `http://127.0.0.1:${PORT}`;
const KEYS = {
  payer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  payee: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  mediator: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  session: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  stranger: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
} as const satisfies Record<string, Hex>;

const haveAnvil = spawnSync("anvil", ["--version"]).status === 0;
const haveArtifacts = existsSync(join(OUT, "MediatedEscrow.sol/MediatedEscrow.json")) && existsSync(join(OUT, "MockUSD8.sol/MockUSD8.json"));
const skip = !haveAnvil || !haveArtifacts ? "requires anvil and `forge build` artifacts" : false;

let anvil: ChildProcess | undefined;
const chain = aevumChain({ CHAIN_ID: 31337, RPC_URL: RPC, EXPLORER_URL: "http://localhost" });
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const testClient = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
const wallet = (k: Hex) => createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(k) });

function artifact(name: string) {
  const j = JSON.parse(readFileSync(join(OUT, `${name}.sol/${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

async function deploy(name: string, args: unknown[] = []): Promise<Address> {
  const { abi, bytecode } = artifact(name);
  const hash = await wallet(KEYS.payer).deployContract({ abi, bytecode, args, type: "legacy" });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  return r.contractAddress!;
}

async function send(k: Hex, address: Address, abi: readonly unknown[], functionName: string, args: unknown[]) {
  const hash = await wallet(k).writeContract({ address, abi: abi as never, functionName: functionName as never, args: args as never, type: "legacy" } as never);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", `${functionName} reverted`);
  return r;
}

before(async () => {
  if (skip) return;
  anvil = spawn("anvil", ["--port", String(PORT), "--hardfork", "shanghai", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      await publicClient.getChainId();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not start");
});

after(() => anvil?.kill());

test("dispute → evidence → AI proposal via session key → both accept → settled", { skip }, async () => {
  const addr = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v).address])) as Record<keyof typeof KEYS, Address>;
  const usdAbi = artifact("MockUSD8").abi;
  const usd = await deploy("MockUSD8");
  const escrow = await deploy("MediatedEscrow", [usd]);
  const esc = { address: escrow, abi: mediatedEscrowAbi } as const;

  // Mediator identity + scoped session key (propose-only, 1 day, budget 3).
  await send(KEYS.mediator, escrow, mediatedEscrowAbi, "registerMediator", ["local://mediator"]);
  const now = (await publicClient.getBlock()).timestamp;
  await send(KEYS.mediator, escrow, mediatedEscrowAbi, "setSessionKey", [addr.session, now + 86_400n, 3]);

  // Payer funds a 1,000 tUSD8 escrow.
  const termsText = "Design a logo. Deliver 3 concepts and final SVG within 5 days.";
  const termsHash = keccak256(toBytes(termsText));
  await send(KEYS.payer, usd, usdAbi, "mint", [addr.payer, 5_000_000_000n]);
  await send(KEYS.payer, usd, usdAbi, "approve", [escrow, 1_000_000_000n]);
  await send(KEYS.payer, escrow, mediatedEscrowAbi, "createEscrow", [
    {
      payee: addr.payee,
      mediator: addr.mediator,
      amount: 1_000_000_000n,
      acceptBy: now + 86_400n,
      activeDuration: 7n * 86_400n,
      evidenceWindow: 3_600n,
      proposeWindow: 3_600n,
      responseWindow: 3_600n,
      undisputedPayeeBps: 10_000,
      disputeFallbackPayeeBps: 5_000,
      termsHash,
    },
  ]);
  const id = 1n;
  const digest = await publicClient.readContract({ ...esc, functionName: "termsDigest", args: [id] });
  await send(KEYS.payee, escrow, mediatedEscrowAbi, "acceptTerms", [id, digest]);

  // Mediator service with a stub engine.
  const dir = await mkdtemp(join(tmpdir(), "fairhold-e2e-"));
  const cfg = loadConfig({
    RPC_URL: RPC,
    CHAIN_ID: "31337",
    EXPLORER_URL: "http://localhost",
    ESCROW_ADDRESS: escrow,
    MEDIATOR_ADDRESS: addr.mediator,
    SESSION_KEY_PRIVATE_KEY: KEYS.session,
    MEDIATOR_MODE: "rules",
    EVIDENCE_DIR: dir,
    POLL_INTERVAL_MS: "1000",
  });
  const store = new Store(dir);
  await store.init();
  let seen: DisputeContext | undefined;
  const engine: DecisionEngine = {
    async decide(ctx) {
      seen = ctx;
      return {
        decision: { payee_share_bps: 7000, confidence: "medium", summary: "Partial delivery.", findings: [], rationale: "2 of 3 concepts.", suspicious_instructions_detected: false },
        engine: { mode: "claude", model: "stub" },
      };
    },
  };
  const walletClient = createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(KEYS.session) });
  const worker = new MediatorWorker({ cfg, publicClient: publicClient as never, walletClient: walletClient as never, store, engine, log: () => {} });
  const app = buildServer({ cfg, publicClient: publicClient as never, store, worker, sessionKey: addr.session });

  async function upload(k: Hex, kind: "terms" | "evidence", body: string, mimeType = "text/plain") {
    const bytes = toBytes(body);
    const contentHash = keccak256(bytes);
    const signature = await wallet(k).signMessage({ message: uploadMessage({ chainId: 31337, escrow, escrowId: id, contentHash, kind }) });
    return app.inject({
      method: "POST",
      url: "/evidence",
      payload: { escrowId: "1", kind, name: `${kind}.txt`, mimeType, contentBase64: Buffer.from(bytes).toString("base64"), signature },
    });
  }

  assert.equal((await upload(KEYS.payer, "terms", termsText)).statusCode, 201);
  assert.equal((await upload(KEYS.payer, "terms", "tampered terms")).statusCode, 400, "terms must match termsHash");
  assert.equal((await upload(KEYS.stranger, "evidence", "fake")).statusCode, 403, "strangers cannot upload");

  const evidenceText = "Delivered concepts A and B on day 4 (links in thread). Concept C pending client feedback.";
  const up = await upload(KEYS.payee, "evidence", evidenceText);
  assert.equal(up.statusCode, 201);
  const { contentHash, uri } = up.json() as { contentHash: Hex; uri: string };
  await send(KEYS.payee, escrow, mediatedEscrowAbi, "submitEvidence", [id, contentHash, uri]);
  // A hash committed on-chain without uploading the file is reported as missing.
  await send(KEYS.payer, escrow, mediatedEscrowAbi, "openDispute", [id]);
  await send(KEYS.payer, escrow, mediatedEscrowAbi, "submitEvidence", [id, keccak256(toBytes("never uploaded")), ""]);

  // Evidence window open: the worker must wait.
  await worker.tick();
  assert.equal(seen, undefined);

  await testClient.increaseTime({ seconds: 3_601 });
  await testClient.mine({ blocks: 1 });
  await worker.tick();

  const ctx = seen as DisputeContext | undefined;
  assert.ok(ctx, "engine consulted after evidence window");
  assert.equal(ctx.termsText, termsText);
  assert.equal(ctx.disputedBy, "payer");
  assert.deepEqual(ctx.evidence.map((e) => e.status), ["verified", "missing"]);

  const e = await publicClient.readContract({ ...esc, functionName: "getEscrow", args: [id] });
  assert.equal(e.status, 4, "Proposed");
  assert.equal(e.proposedPayeeAmount, 700_000_000n);
  assert.equal(e.proposer, addr.session, "submitted by the session key, not the owner");
  const job = store.getJob("1")!;
  assert.equal(job.status, "submitted");
  assert.ok(job.txHash);

  // Reasoning is retrievable and hashes to the on-chain commitment.
  const reasoning = await app.inject({ method: "GET", url: `/reasoning/${e.reasoningHash}` });
  assert.equal(reasoning.statusCode, 200);
  assert.equal(keccak256(toBytes(reasoning.body)), e.reasoningHash);

  // Idempotent: another tick does not re-propose or consume budget.
  await worker.tick();
  const m = await publicClient.readContract({ ...esc, functionName: "getMediator", args: [addr.mediator] });
  assert.equal(m.sessionBudget, 2);
  assert.equal(m.proposals, 1);

  // Both parties accept → funds move.
  await send(KEYS.payer, escrow, mediatedEscrowAbi, "respondToProposal", [id, true]);
  await send(KEYS.payee, escrow, mediatedEscrowAbi, "respondToProposal", [id, true]);
  const bal = (a: Address) => publicClient.readContract({ address: usd, abi: usdAbi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
  assert.equal(await bal(addr.payee), 700_000_000n);
  assert.equal(await bal(escrow), 0n);

  const health = (await app.inject({ method: "GET", url: "/health" })).json() as { session: { stats: { accepted: number } } };
  assert.equal(health.session.stats.accepted, 1);
  await app.close();
});
