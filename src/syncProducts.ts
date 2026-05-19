import { AppConfig } from "./config.js";
import { resolveProductCategoryId, syncCategories } from "./categorySync.js";
import { createDb } from "./db.js";
import { logger } from "./logger.js";
import { mapSupplierToWebasyst, normalizeSupplierProduct, shouldSkipProduct } from "./productMapper.js";
import { ProductMapStore } from "./productMapStore.js";
import { SupplierApi } from "./supplierApi.js";
import { SupplierDataRepository } from "./supplierDataRepository.js";
import { TelegramNotifier } from "./telegramNotifier.js";
import { SupplierProduct } from "./types.js";
import { WebasystApi } from "./webasystApi.js";

export type SyncStats = {
  totalReceived: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
};

export async function syncProducts(config: AppConfig): Promise<SyncStats> {
  const supplierApi = new SupplierApi(config);
  const webasystApi = new WebasystApi(config);
  const supplierDataRepository = new SupplierDataRepository(createDb(config));
  const productMapStore = new ProductMapStore(config.productMapPath);
  try {
    await productMapStore.load();

  const supplierCategories = await supplierApi.getCategories();
  const rawProducts = await supplierApi.getProducts(config.importLimit);
  const allProducts = rawProducts.map(normalizeSupplierProduct);
  await supplierDataRepository.saveSnapshot(supplierCategories, allProducts);
  const categoryRules = supplierDataRepository.enabled ? await supplierDataRepository.getCategoryRules() : undefined;
  const products = categoryRules ? allProducts.filter((product) => isProductCategoryEnabled(product, categoryRules.enabledCategoryKeys)) : allProducts;
  const precheck = products.map((product) => shouldSkipProduct(product));
  await new TelegramNotifier(config).notifySupplierProductsFetched({
    source: "syncProducts",
    products,
    valid: precheck.filter((reason) => !reason).length,
    skipped: precheck.filter(Boolean).length,
    importLimit: config.importLimit,
    dryRun: config.dryRun
  });
  const categorySyncResult = await syncCategories(supplierCategories, products, config, webasystApi);
  const stats: SyncStats = {
    totalReceived: allProducts.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0
  };

  logger.info("Starting sync", {
    totalReceived: stats.totalReceived,
    selectedForSync: products.length,
    dryRun: config.dryRun,
    importLimit: config.importLimit
  });

  for (const product of products) {
    try {
      const skipReason = shouldSkipProduct(product);
      if (skipReason) {
        stats.skipped += 1;
        logger.warn("Product skipped", { id: product.id, sku: product.sku, reason: skipReason });
        continue;
      }

      const categoryId = resolveProductCategoryId(product, config, categorySyncResult.categoryIds);
      const markupPercent = categoryRules ? getProductCategoryMarkup(product, categoryRules.markupByCategoryKey) : undefined;
      const webasystProduct = mapSupplierToWebasyst(product, config, categoryId, markupPercent);
      let mapEntry = productMapStore.get(product.id);

      if (config.dryRun) {
        logger.info(`DRY_RUN: would ${mapEntry ? "update" : "create"} product`, {
          externalId: product.id,
          webasystProductId: mapEntry?.webasyst_product_id,
          sku: product.sku,
          name: product.name,
          price: webasystProduct.skus["0"]?.price,
          categoryId
        });
        mapEntry ? stats.updated++ : stats.created++;
        continue;
      }

      if (!mapEntry) {
        const existingProductId = await webasystApi.findProductBySupplierIdentity(product.id, product.sku);
        if (existingProductId) {
          productMapStore.set(product.id, {
            webasyst_product_id: existingProductId,
            sku: product.sku
          });
          await productMapStore.save();
          mapEntry = productMapStore.get(product.id);
          logger.info("Linked existing Webasyst product to supplier product", {
            externalId: product.id,
            sku: product.sku,
            webasystProductId: existingProductId
          });
        }
      }

      if (mapEntry) {
        const updatedId = await webasystApi.updateProduct(mapEntry.webasyst_product_id, webasystProduct);
        if (!updatedId) {
          throw new Error("Webasyst update response did not contain product id");
        }
        productMapStore.set(product.id, {
          webasyst_product_id: updatedId,
          sku: product.sku
        });
        await productMapStore.save();
        stats.updated += 1;
        logger.info("Product updated", { externalId: product.id, webasystProductId: updatedId });
      } else {
        const createdId = await webasystApi.createProduct(webasystProduct);
        if (!createdId) {
          throw new Error("Webasyst create response did not contain product id; mapping was not saved");
        }

        productMapStore.set(product.id, {
          webasyst_product_id: createdId,
          sku: product.sku
        });
        await productMapStore.save();
        await uploadImagesForCreatedProduct(supplierApi, webasystApi, createdId, product);
        stats.created += 1;
        logger.info("Product created", { externalId: product.id, webasystProductId: createdId });
      }
    } catch (error) {
      stats.errors += 1;
      logger.error("Product sync failed", {
        id: product.id,
        sku: product.sku,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (!config.dryRun) {
    await productMapStore.save();
  }

    logger.info("Sync finished", stats);
    return stats;
  } finally {
    await supplierDataRepository.destroy();
  }
}

function isProductCategoryEnabled(product: SupplierProduct, enabledCategoryKeys: Set<string>): boolean {
  return getProductCategoryKeys(product).some((key) => enabledCategoryKeys.has(key));
}

function getProductCategoryMarkup(product: SupplierProduct, markupByCategoryKey: Map<string, number>): number | undefined {
  const keys = getProductCategoryKeys(product);
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const markup = markupByCategoryKey.get(keys[index]);
    if (markup !== undefined) return markup;
  }
  return undefined;
}

function getProductCategoryKeys(product: SupplierProduct): string[] {
  const keys: string[] = [];
  const path = product.supplierCategoryPath ?? product.categoryPath;
  if (path?.length) {
    for (let index = 1; index <= path.length; index += 1) {
      keys.push(path.slice(0, index).join(" > "));
    }
  }
  if (product.supplierCategoryId) keys.push(product.supplierCategoryId);
  return keys;
}

async function uploadImagesForCreatedProduct(
  supplierApi: SupplierApi,
  webasystApi: WebasystApi,
  webasystProductId: number,
  product: SupplierProduct
): Promise<void> {
  for (const imageUrl of product.images ?? []) {
    try {
      const image = await supplierApi.downloadImage(imageUrl);
      await webasystApi.addProductImage(webasystProductId, image);
    } catch (error) {
      logger.warn("Image upload failed; product itself remains synced", {
        externalId: product.id,
        webasystProductId,
        imageUrl,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
