import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { syncProducts } from "./syncProducts.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const stats = await syncProducts(config);

  console.log("");
  console.log("Sync statistics");
  console.log(`total received: ${stats.totalReceived}`);
  console.log(`created: ${stats.created}`);
  console.log(`updated: ${stats.updated}`);
  console.log(`skipped: ${stats.skipped}`);
  console.log(`errors: ${stats.errors}`);
  console.log(`duration: ${Math.round(stats.durationMs / 100) / 10}s`);

  if (stats.errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  logger.error("Fatal sync error", error);
  process.exitCode = 1;
});
