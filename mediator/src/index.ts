import "dotenv/config";
import { resolve } from "node:path";
import { makeClients } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { ClaudeEngine, RulesEngine, type DecisionEngine } from "./policy.ts";
import { buildServer } from "./server.ts";
import { openDeploymentStore } from "./store.ts";
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

  // One namespace per (chain, escrow contract): escrow ids restart at 1 on every deployment.
  const { store, dir: storeDir, legacyDataAt } = await openDeploymentStore(resolve(cfg.EVIDENCE_DIR), {
    chainId: cfg.CHAIN_ID,
    escrow: cfg.ESCROW_ADDRESS,
  });
  if (legacyDataAt) {
    console.warn(
      `Found un-namespaced store data in ${legacyDataAt} from an older version. It was left untouched because ` +
        `its deployment can't be confirmed. If it belongs to chain ${cfg.CHAIN_ID} escrow ${cfg.ESCROW_ADDRESS}, ` +
        `move its jobs.json, evidence/ and reasoning/ into ${storeDir} while the service is stopped.`,
    );
  }

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
