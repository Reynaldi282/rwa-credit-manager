import { loadConfig } from "./config";
import { Keeper } from "./keeper";
import { log } from "./logger";
import { startServer } from "./server";

async function main() {
  const cfg = loadConfig();
  const keeper = new Keeper(cfg);
  log.info("RWA Credit Manager keeper starting", {
    chainId: cfg.chainId,
    rpc: cfg.rpcUrl.replace(/\/\/([^/]+)\/.*$/, "//$1/…"), // don't log API keys in RPC paths
    guard: cfg.guard,
    keeper: keeper.address,
    pollIntervalMs: cfg.pollIntervalMs,
  });

  if (process.argv.includes("--once")) {
    const r = await keeper.tick("once");
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.error ? 1 : 0);
  }

  const server = startServer(keeper);
  keeper.start();
  const shutdown = () => {
    log.info("shutting down");
    keeper.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log.error("fatal", { reason: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
