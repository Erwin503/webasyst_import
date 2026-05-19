import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { WorkerController } from "./workerController.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const worker = new WorkerController(config);
  await worker.start();

  logger.info("Supplier sync worker started", {
    supplierSyncIntervalHours: await worker.getIntervalHours(),
    dryRun: config.dryRun,
    importLimit: config.importLimit
  });
}

main().catch((error) => {
  logger.error("Worker fatal error", error);
  process.exitCode = 1;
});
