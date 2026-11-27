import "dotenv/config";
import { resolve } from "node:path";
import { makeClients } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { ClaudeEngine, RulesEngine, type DecisionEngine } from "./policy.ts";
import { buildServer } from "./server.ts";
import { Store } from "./store.ts";
import { MediatorWorker } from "./worker.ts";

async function main() {
  const cfg = loadConfig();
  const { publicClient, walletClient, account } = makeClients(cfg);

  if (account && account.address.toLowerCase() === cfg.MEDIATOR_ADDRESS.toLowerCase()) {
    throw new Error("SESSION_KEY_PRIVATE_KEY must be a scoped session key, not the mediator owner key");
  }

  let engine: DecisionEngine;
  if (cfg.MEDIATOR_MODE === "claude") {
    engine = new ClaudeEngine(cfg.ANTHROPIC_MODEL, cfg.ANTHROPIC_API_KEY || undefined);
  } else {
    engine = new RulesEngine();
  }

  const store = new Store(resolve(cfg.EVIDENCE_DIR));
  await store.init();

  let app: ReturnType<typeof buildServer> | undefined;
  const worker = new MediatorWorker({
    cfg,
    publicClient,
    walletClient,
    store,
    engine,
    log: (msg, extra) => (app ? app.log.info(extra ?? {}, msg) : console.log(msg, extra ?? "")),
  });
  app = buildServer({ cfg, publicClient, store, worker, sessionKey: account?.address });

  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      controller.abort();
      void app.close().then(() => process.exit(0));
    });
  }

  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  app.log.info({ escrow: cfg.ESCROW_ADDRESS, mediator: cfg.MEDIATOR_ADDRESS, sessionKey: account?.address, mode: cfg.MEDIATOR_MODE }, "FairHold mediator started");
  void worker.start(controller.signal);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
