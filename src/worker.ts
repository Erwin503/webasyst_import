import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { syncProducts } from "./syncProducts.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const intervalMs = config.supplierSyncIntervalHours * 60 * 60 * 1000;

  logger.info("Starting supplier sync worker", {
    supplierSyncIntervalHours: config.supplierSyncIntervalHours,
    dryRun: config.dryRun,
    importLimit: config.importLimit
  });

  await runOnce();
  setInterval(() => {
    void runOnce();
  }, intervalMs);

  async function runOnce(): Promise<void> {
    try {
      const stats = await syncProducts(config);
      logger.info("Worker sync run finished", stats);
    } catch (error) {
      logger.error("Worker sync run failed", error);
    }
  }
}

main().catch((error) => {
  logger.error("Worker fatal error", error);
  process.exitCode = 1;
});
