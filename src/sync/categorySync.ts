import { WebasystApi, WebasystCategoryTreeItem } from "../api/webasystApi.js";
import { AppConfig } from "../config/config.js";
import { logger } from "../config/logger.js";
import { CategoryMapStore } from "../repositories/categoryMapStore.js";
import { SupplierDataRepository } from "../repositories/supplierDataRepository.js";
import { SupplierCategory, SupplierProduct, WebasystCategory } from "../types/domain.js";

export type CategorySyncResult = {
  categoryIds: Map<string, number>;
  created: number;
  updated: number;
  linkedExisting: number;
  skipped: number;
};

export async function syncCategories(
  categories: SupplierCategory[],
  products: SupplierProduct[],
  config: AppConfig,
  webasystApi: WebasystApi,
  supplierDataRepository?: SupplierDataRepository
): Promise<CategorySyncResult> {
  const result: CategorySyncResult = {
    categoryIds: new Map(),
    created: 0,
    updated: 0,
    linkedExisting: 0,
    skipped: 0
  };

  if (config.supplierCategoryMode === "single") {
    logger.info("Supplier category mode is single; all products will use preorder root category", {
      webasystCategoryId: config.webasyst.preorderRootCategoryId
    });
    return result;
  }

  const usedCategoryKeys = collectUsedCategoryKeys(products);
  const store = supplierDataRepository?.enabled ? undefined : new CategoryMapStore(config.categoryMapPath);
  await store?.load();

  const existingTree = config.dryRun ? [] : await webasystApi.getCategoryTree(config.webasyst.preorderRootCategoryId);
  const existingByParentAndName = indexWebasystCategories(existingTree);
  let dryRunCategoryId = -1;

  for (const category of flattenSupplierCategories(categories)) {
    const key = supplierCategoryKey(category);
    if (!isCategoryUsed(category, usedCategoryKeys)) {
      result.skipped += 1;
      continue;
    }

    const parentWebasystId = category.parentId
      ? result.categoryIds.get(category.parentId) ?? (await getStoredCategoryId(category.parentId, supplierDataRepository, store))
      : config.webasyst.preorderRootCategoryId;

    if (!parentWebasystId) {
      logger.warn("Supplier category skipped because parent category was not synced", {
        supplierCategoryId: key,
        parentSupplierCategoryId: category.parentId
      });
      result.skipped += 1;
      continue;
    }

    const payload = mapSupplierCategoryToWebasyst(category, parentWebasystId);
    const mapEntry = await getStoredCategoryId(key, supplierDataRepository, store);

    if (mapEntry) {
      setResolvedCategoryId(result.categoryIds, category, mapEntry);
      if (!config.dryRun) {
        await webasystApi.updateCategory(mapEntry, payload);
        await saveCategoryMapping(key, mapEntry, category, supplierDataRepository, store);
      }
      result.updated += 1;
      continue;
    }

    const existing = existingByParentAndName.get(existingCategoryKey(parentWebasystId, category.name));
    if (existing) {
      setResolvedCategoryId(result.categoryIds, category, existing.id);
      if (!config.dryRun) {
        await webasystApi.updateCategory(existing.id, payload);
        await saveCategoryMapping(key, existing.id, category, supplierDataRepository, store);
      }
      result.linkedExisting += 1;
      logger.info("Linked existing Webasyst category to supplier category", {
        supplierCategoryId: key,
        webasystCategoryId: existing.id,
        name: category.name
      });
      continue;
    }

    if (config.dryRun) {
      logger.info("DRY_RUN: would create supplier category in Webasyst", {
        supplierCategoryId: key,
        name: category.name,
        parentWebasystId,
        path: category.path
      });
      setResolvedCategoryId(result.categoryIds, category, dryRunCategoryId);
      dryRunCategoryId -= 1;
      result.created += 1;
      continue;
    }

    const createdId = await webasystApi.createCategory(payload);
    if (!createdId) {
      throw new Error(`Webasyst category create response did not contain id for supplier category ${key}`);
    }

    await saveCategoryMapping(key, createdId, category, supplierDataRepository, store);
    setResolvedCategoryId(result.categoryIds, category, createdId);
    existingByParentAndName.set(existingCategoryKey(parentWebasystId, category.name), {
      id: createdId,
      parent_id: parentWebasystId,
      name: category.name
    });
    result.created += 1;
    logger.info("Created Webasyst category", {
      supplierCategoryId: key,
      webasystCategoryId: createdId,
      name: category.name
    });
  }

  if (!config.dryRun) {
    await store?.save();
  }

  logger.info("Category sync finished", resultWithoutMap(result));
  return result;
}

async function getStoredCategoryId(
  key: string,
  supplierDataRepository?: SupplierDataRepository,
  store?: CategoryMapStore
): Promise<number | undefined> {
  if (supplierDataRepository?.enabled) {
    return (await supplierDataRepository.getCategoryMapping(key))?.webasystCategoryId;
  }
  return store?.get(key)?.webasyst_category_id;
}

async function saveCategoryMapping(
  key: string,
  webasystCategoryId: number,
  category: SupplierCategory,
  supplierDataRepository?: SupplierDataRepository,
  store?: CategoryMapStore
): Promise<void> {
  if (supplierDataRepository?.enabled) {
    await supplierDataRepository.saveCategoryMapping(key, webasystCategoryId);
    return;
  }
  store?.set(key, {
    webasyst_category_id: webasystCategoryId,
          name: category.name,
          parent_supplier_category_id: category.parentId
  });
}

export function resolveProductCategoryId(
  product: SupplierProduct,
  config: AppConfig,
  categoryIds: Map<string, number>
): number {
  if (config.supplierCategoryMode === "single") {
    return config.webasyst.preorderRootCategoryId;
  }

  if (product.supplierCategoryId) {
    const byId = categoryIds.get(product.supplierCategoryId);
    if (byId) return byId;
  }

  const categoryPath = product.supplierCategoryPath ?? product.categoryPath;
  if (categoryPath?.length) {
    const byPath = categoryIds.get(pathCategoryKey(categoryPath));
    if (byPath) return byPath;
  }

  return config.webasyst.preorderRootCategoryId;
}

function mapSupplierCategoryToWebasyst(category: SupplierCategory, parentWebasystId: number): WebasystCategory {
  return {
    name: category.name,
    parent_id: parentWebasystId,
    url: slugify(category.path.join("-")) || `supplier-category-${category.id}`,
    status: 1,
    include_sub_categories: category.children.length > 0 ? 1 : 0
  };
}

function flattenSupplierCategories(categories: SupplierCategory[]): SupplierCategory[] {
  const result: SupplierCategory[] = [];
  const walk = (category: SupplierCategory) => {
    result.push(category);
    for (const child of category.children) {
      walk(child);
    }
  };
  categories.forEach(walk);
  return result;
}

function collectUsedCategoryKeys(products: SupplierProduct[]): Set<string> {
  const keys = new Set<string>();
  for (const product of products) {
    if (product.supplierCategoryId) {
      keys.add(product.supplierCategoryId);
    }
    const categoryPath = product.supplierCategoryPath ?? product.categoryPath;
    for (let index = 1; index <= (categoryPath?.length ?? 0); index += 1) {
      keys.add(pathCategoryKey(categoryPath!.slice(0, index)));
    }
  }
  return keys;
}

function isCategoryUsed(category: SupplierCategory, usedKeys: Set<string>): boolean {
  if (usedKeys.has(category.id) || usedKeys.has(pathCategoryKey(category.path))) {
    return true;
  }
  return category.children.some((child) => isCategoryUsed(child, usedKeys));
}

function supplierCategoryKey(category: SupplierCategory): string {
  return category.id || pathCategoryKey(category.path);
}

function setResolvedCategoryId(categoryIds: Map<string, number>, category: SupplierCategory, webasystCategoryId: number): void {
  categoryIds.set(supplierCategoryKey(category), webasystCategoryId);
  categoryIds.set(pathCategoryKey(category.path), webasystCategoryId);
}

function pathCategoryKey(path: string[]): string {
  return path.join(" > ");
}

function indexWebasystCategories(categories: WebasystCategoryTreeItem[]): Map<string, WebasystCategoryTreeItem> {
  const result = new Map<string, WebasystCategoryTreeItem>();
  const walk = (category: WebasystCategoryTreeItem) => {
    result.set(existingCategoryKey(category.parent_id, category.name), category);
    for (const child of category.categories ?? category.children ?? []) {
      walk(child);
    }
  };
  categories.forEach(walk);
  return result;
}

function existingCategoryKey(parentId: number, name: string): string {
  return `${parentId}\u0000${normalizeName(name)}`;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function slugify(value: string): string {
  return transliterate(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function transliterate(value: string): string {
  const table: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
    и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
    с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
    ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
  };
  return value
    .split("")
    .map((char) => table[char.toLowerCase()] ?? char)
    .join("");
}

function resultWithoutMap(result: CategorySyncResult): Omit<CategorySyncResult, "categoryIds"> & { mapped: number } {
  return {
    created: result.created,
    updated: result.updated,
    linkedExisting: result.linkedExisting,
    skipped: result.skipped,
    mapped: result.categoryIds.size
  };
}
