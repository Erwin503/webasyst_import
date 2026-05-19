import { SupplierApi } from "../api/supplierApi.js";
import { TelegramNotifier } from "../api/telegramNotifier.js";
import { loadSupplierOnlyConfig } from "../config/config.js";
import { createDb } from "../db/db.js";
import { logger } from "../config/logger.js";
import { SupplierDataRepository } from "../repositories/supplierDataRepository.js";
import { normalizeSupplierProduct, shouldSkipProduct } from "../sync/productMapper.js";

async function main(): Promise<void> {
  const config = loadSupplierOnlyConfig();
  const supplierApi = new SupplierApi(config);
  const supplierDataRepository = new SupplierDataRepository(createDb(config));
  const supplierCategories = await supplierApi.getCategories();
  const rawProducts = await supplierApi.getProducts(config.importLimit);
  const products = rawProducts.map(normalizeSupplierProduct);
  await supplierDataRepository.saveSnapshot(supplierCategories, products);
  await supplierDataRepository.destroy();
  const skipped = products
    .map((product) => ({ product, reason: shouldSkipProduct(product) }))
    .filter((item) => item.reason);
  const valid = products.length - skipped.length;
  const withSupplierImageFlag = products.filter((product) => Boolean((product.raw as { has_image?: boolean } | undefined)?.has_image)).length;
  const withCategoryPath = products.filter((product) => (product.supplierCategoryPath?.length ?? 0) > 0).length;

  await new TelegramNotifier(config).notifySupplierProductsFetched({
    source: "checkSupplierProducts",
    products,
    valid,
    skipped: skipped.length,
    importLimit: config.importLimit,
    dryRun: true
  });

  console.log("");
  console.log("Supplier products check");
  console.log(`received: ${products.length}`);
  console.log(`valid for import: ${valid}`);
  console.log(`skipped by mapper: ${skipped.length}`);
  console.log(`with category path: ${withCategoryPath}`);
  console.log(`with supplier image flag: ${withSupplierImageFlag}`);
  console.log("image URLs: not fetched in supplier-only check");
  console.log(`import limit: ${config.importLimit ?? "none"}`);

  console.log("");
  console.log("Sample products");
  for (const product of products.slice(0, 5)) {
    console.log(JSON.stringify({
      id: product.id,
      sku: product.sku,
      name: product.name,
      price: product.price,
      quantity: product.quantity,
      supplierCategoryId: product.supplierCategoryId,
      supplierCategoryPath: product.supplierCategoryPath,
      images: product.images?.slice(0, 3) ?? [],
      brand: product.brand,
      barcode: product.barcode
    }, null, 2));
  }

  if (skipped.length > 0) {
    console.log("");
    console.log("Skipped samples");
    for (const item of skipped.slice(0, 5)) {
      console.log(JSON.stringify({
        id: item.product.id,
        sku: item.product.sku,
        name: item.product.name,
        price: item.product.price,
        reason: item.reason
      }, null, 2));
    }
  }
}

main().catch((error) => {
  logger.error("Supplier products check failed", error);
  process.exitCode = 1;
});
