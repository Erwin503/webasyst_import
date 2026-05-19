import { SupplierApi } from "../api/supplierApi.js";
import { TelegramNotifier } from "../api/telegramNotifier.js";
import { WebasystApi } from "../api/webasystApi.js";
import { AppConfig } from "../config/config.js";
import { logger } from "../config/logger.js";
import { createDb } from "../db/db.js";
import { ProductMapStore } from "../repositories/productMapStore.js";
import { SupplierDataRepository } from "../repositories/supplierDataRepository.js";
import { SupplierProduct } from "../types/domain.js";
import { resolveProductCategoryId, syncCategories } from "./categorySync.js";
import { mapSupplierToWebasyst, normalizeSupplierProduct, shouldSkipProduct } from "./productMapper.js";

export type SyncStats = {
  totalReceived: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  durationMs: number;
};

export async function syncProducts(config: AppConfig): Promise<SyncStats> {
  const startedAt = Date.now();
  const supplierApi = new SupplierApi(config);
  const webasystApi = new WebasystApi(config);
  const supplierDataRepository = new SupplierDataRepository(createDb(config));
  const productMapStore = supplierDataRepository.enabled ? undefined : new ProductMapStore(config.productMapPath);
  try {
    await productMapStore?.load();

  const supplierCategories = await supplierApi.getCategories();
  const rawProducts = await supplierApi.getProducts(config.importLimit);
  const allProducts = rawProducts.map(normalizeSupplierProduct);
  await supplierDataRepository.saveSnapshot(supplierCategories, allProducts);
  const categoryRules = supplierDataRepository.enabled ? await supplierDataRepository.getCategoryRules() : undefined;
  const products = categoryRules ? allProducts.filter((product) => isProductCategoryEnabled(product, categoryRules.enabledCategoryKeys)) : allProducts;
  if (!config.dryRun) {
    await attachImagesForSelectedProducts(supplierApi, products);
  } else {
    logger.info("Supplier image URL fetching skipped in DRY_RUN");
  }
  const precheck = products.map((product) => shouldSkipProduct(product));
  const categorySyncResult = await syncCategories(supplierCategories, products, config, webasystApi, supplierDataRepository);
  const stats: SyncStats = {
    totalReceived: allProducts.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    durationMs: 0
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
      let mapEntry = await getProductMapping(product.id, supplierDataRepository, productMapStore);

      if (config.dryRun) {
        logger.info(`DRY_RUN: would ${mapEntry ? "update" : "create"} product`, {
          externalId: product.id,
          webasystProductId: mapEntry?.webasystProductId,
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
          await saveProductMapping(product.id, existingProductId, product.sku, supplierDataRepository, productMapStore);
          mapEntry = await getProductMapping(product.id, supplierDataRepository, productMapStore);
          logger.info("Linked existing Webasyst product to supplier product", {
            externalId: product.id,
            sku: product.sku,
            webasystProductId: existingProductId
          });
        }
      }

      if (mapEntry) {
        const updatedId = await webasystApi.updateProduct(mapEntry.webasystProductId, webasystProduct);
        if (!updatedId) {
          throw new Error("Webasyst update response did not contain product id");
        }
        await saveProductMapping(product.id, updatedId, product.sku, supplierDataRepository, productMapStore);
        stats.updated += 1;
        logger.info("Product updated", { externalId: product.id, webasystProductId: updatedId });
      } else {
        const createdId = await webasystApi.createProduct(webasystProduct);
        if (!createdId) {
          throw new Error("Webasyst create response did not contain product id; mapping was not saved");
        }

        await saveProductMapping(product.id, createdId, product.sku, supplierDataRepository, productMapStore);
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

  if (!config.dryRun && config.importLimit === undefined) {
    await hideMissingSupplierProducts(supplierDataRepository, productMapStore, webasystApi, stats);
    await productMapStore?.save();
  } else if (!config.dryRun && config.importLimit !== undefined) {
    logger.info("Missing supplier product hiding skipped because IMPORT_LIMIT is set", {
      importLimit: config.importLimit
    });
  }

    stats.durationMs = Date.now() - startedAt;
    await new TelegramNotifier(config).notifySupplierProductsFetched({
      source: "syncProducts",
      products,
      valid: precheck.filter((reason) => !reason).length,
      skipped: precheck.filter(Boolean).length,
      importLimit: config.importLimit,
      dryRun: config.dryRun,
      durationMs: stats.durationMs
    });
    logger.info("Sync finished", {
      ...stats,
      durationSeconds: Math.round(stats.durationMs / 100) / 10
    });
    return stats;
  } finally {
    await supplierDataRepository.destroy();
  }
}

async function attachImagesForSelectedProducts(supplierApi: SupplierApi, products: SupplierProduct[]): Promise<void> {
  const imageSkus = products
    .filter((product) => supplierProductHasImage(product))
    .map((product) => product.sku);

  const imagesBySku = await supplierApi.getImageUrlsBySkus(imageSkus);
  for (const product of products) {
    product.images = imagesBySku.get(product.sku) ?? [];
  }
}

function supplierProductHasImage(product: SupplierProduct): boolean {
  return Boolean((product.raw as { has_image?: boolean } | undefined)?.has_image);
}

type ProductMapping = {
  webasystProductId: number;
  sku: string;
};

async function getProductMapping(
  supplierProductId: string,
  supplierDataRepository: SupplierDataRepository,
  productMapStore?: ProductMapStore
): Promise<ProductMapping | undefined> {
  if (supplierDataRepository.enabled) {
    return supplierDataRepository.getProductMapping(supplierProductId);
  }

  const entry = productMapStore?.get(supplierProductId);
  if (!entry) return undefined;
  return {
    webasystProductId: entry.webasyst_product_id,
    sku: entry.sku
  };
}

async function saveProductMapping(
  supplierProductId: string,
  webasystProductId: number,
  sku: string,
  supplierDataRepository: SupplierDataRepository,
  productMapStore?: ProductMapStore
): Promise<void> {
  if (supplierDataRepository.enabled) {
    await supplierDataRepository.saveProductMapping(supplierProductId, webasystProductId, sku);
    return;
  }

  productMapStore?.set(supplierProductId, {
    webasyst_product_id: webasystProductId,
    sku
  });
  await productMapStore?.save();
}

async function hideMissingSupplierProducts(
  supplierDataRepository: SupplierDataRepository,
  productMapStore: ProductMapStore | undefined,
  webasystApi: WebasystApi,
  stats: SyncStats
): Promise<void> {
  if (!supplierDataRepository.enabled) return;

  const missingProducts = await supplierDataRepository.getMissingProductsForWebasystHide();
  for (const missing of missingProducts) {
    try {
      const mapEntry = await getProductMapping(missing.supplierProductId, supplierDataRepository, productMapStore);
      const webasystProductId = missing.webasystProductId ?? mapEntry?.webasystProductId
        ?? await webasystApi.findProductBySupplierIdentity(missing.supplierProductId, missing.sku);

      if (!webasystProductId) {
        logger.warn("Missing supplier product was not found in Webasyst, cannot hide", missing);
        await supplierDataRepository.markProductHiddenInWebasyst(missing.supplierProductId);
        continue;
      }

      await webasystApi.hideProduct(webasystProductId, missing.supplierProductId);
      await saveProductMapping(missing.supplierProductId, webasystProductId, missing.sku, supplierDataRepository, productMapStore);
      await supplierDataRepository.markProductHiddenInWebasyst(missing.supplierProductId);
      stats.updated += 1;
      logger.info("Missing supplier product hidden in Webasyst", {
        supplierProductId: missing.supplierProductId,
        webasystProductId
      });
    } catch (error) {
      stats.errors += 1;
      logger.error("Failed to hide missing supplier product", {
        supplierProductId: missing.supplierProductId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
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
