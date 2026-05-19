import { Knex } from "knex";
import { logger } from "./logger.js";
import { SupplierCategory, SupplierProduct } from "./types.js";

export class SupplierDataRepository {
  constructor(private readonly db?: Knex) {}

  get enabled(): boolean {
    return Boolean(this.db);
  }

  async saveSnapshot(categories: SupplierCategory[], products: SupplierProduct[]): Promise<void> {
    if (!this.db) return;

    await this.saveCategories(categories);
    await this.saveProducts(products);

    logger.info("Supplier snapshot saved to MySQL", {
      categories: flattenCategories(categories).length,
      products: products.length
    });
  }

  async getCategorySettingsTree(): Promise<CategorySettingsNode[]> {
    const db = this.requireDb();
    const rows = await db("supplier_categories")
      .select("*")
      .orderBy("path_json", "asc");
    return buildSettingsTree(rows.map(mapCategorySettingsRow));
  }

  async updateCategorySettings(settings: CategorySettingUpdate[]): Promise<void> {
    const db = this.requireDb();
    for (const setting of settings) {
      await db("supplier_categories")
        .where({ supplier_category_key: setting.supplierCategoryKey })
        .update({
          enabled: setting.enabled,
          markup_percent: setting.markupPercent ?? null,
          updated_at: new Date()
        });
    }
  }

  async getEnabledCategoryKeysWithDescendants(): Promise<Set<string>> {
    const tree = await this.getCategorySettingsTree();
    const enabled = new Set<string>();
    const walk = (node: CategorySettingsNode, inherited: boolean) => {
      const active = inherited || node.enabled;
      if (active) enabled.add(node.supplierCategoryKey);
      for (const child of node.children) {
        walk(child, active);
      }
    };
    tree.forEach((node) => walk(node, false));
    return enabled;
  }

  async getCategoryMarkupMap(): Promise<Map<string, number>> {
    const rows = await this.requireDb()("supplier_categories")
      .select("supplier_category_key", "markup_percent")
      .whereNotNull("markup_percent");
    return new Map(rows.map((row) => [String(row.supplier_category_key), Number(row.markup_percent)]));
  }

  async getCategoryRules(): Promise<CategoryRules> {
    const tree = await this.getCategorySettingsTree();
    const enabledCategoryKeys = new Set<string>();
    const markupByCategoryKey = new Map<string, number>();

    const walk = (node: CategorySettingsNode, inheritedEnabled: boolean, inheritedMarkup?: number) => {
      const enabled = inheritedEnabled || node.enabled;
      const markup = node.markupPercent ?? inheritedMarkup;
      if (enabled) {
        enabledCategoryKeys.add(node.supplierCategoryKey);
      }
      if (markup !== undefined) {
        markupByCategoryKey.set(node.supplierCategoryKey, markup);
      }
      for (const child of node.children) {
        walk(child, enabled, markup);
      }
    };

    tree.forEach((node) => walk(node, false, undefined));
    return { enabledCategoryKeys, markupByCategoryKey };
  }

  async getSetting(key: string): Promise<string | undefined> {
    const row = await this.requireDb()("sync_settings")
      .select("setting_value")
      .where({ setting_key: key })
      .first();
    return row?.setting_value === null || row?.setting_value === undefined ? undefined : String(row.setting_value);
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.requireDb()("sync_settings")
      .insert({
        setting_key: key,
        setting_value: value,
        updated_at: new Date()
      })
      .onConflict("setting_key")
      .merge({
        setting_value: value,
        updated_at: new Date()
      });
  }

  async createSyncRun(source: string): Promise<number | undefined> {
    if (!this.db) return undefined;
    const ids = await this.db("sync_runs").insert({
      source,
      status: "running",
      started_at: new Date()
    });
    return Number(ids[0]);
  }

  async finishSyncRun(id: number | undefined, status: "success" | "failed", stats?: SyncRunStats, error?: unknown): Promise<void> {
    if (!this.db || id === undefined) return;
    await this.db("sync_runs").where({ id }).update({
      status,
      total_received: stats?.totalReceived ?? 0,
      created_count: stats?.created ?? 0,
      updated_count: stats?.updated ?? 0,
      skipped_count: stats?.skipped ?? 0,
      error_count: stats?.errors ?? 0,
      error_message: error instanceof Error ? error.message : error ? String(error) : null,
      finished_at: new Date()
    });
  }

  async getLastSyncRuns(limit = 10): Promise<Record<string, unknown>[]> {
    return this.requireDb()("sync_runs")
      .select("*")
      .orderBy("id", "desc")
      .limit(limit);
  }

  async destroy(): Promise<void> {
    await this.db?.destroy();
  }

  private async saveCategories(categories: SupplierCategory[]): Promise<void> {
    const rows = flattenCategories(categories).map((category) => {
      return {
        supplier_category_key: categoryKey(category),
        supplier_category_id: category.id || null,
        parent_supplier_category_key: category.parentId ?? null,
        name: category.name,
        path_json: JSON.stringify(category.path),
        raw_json: JSON.stringify(category.raw ?? null),
        updated_at: new Date()
      };
    });

    await upsertRows(this.requireDb(), "supplier_categories", rows, "supplier_category_key", [
      "supplier_category_id",
      "parent_supplier_category_key",
      "name",
      "path_json",
      "raw_json",
      "updated_at"
    ]);
  }

  private async saveProducts(products: SupplierProduct[]): Promise<void> {
    const rows = products.map((product) => {
      return {
        supplier_product_id: product.id,
        sku: product.sku,
        name: product.name,
        price: product.price,
        old_price: product.oldPrice ?? null,
        currency: product.currency ?? null,
        quantity: product.quantity ?? null,
        supplier_category_key: product.supplierCategoryId ?? categoryPathKey(product.supplierCategoryPath ?? product.categoryPath),
        supplier_category_id: product.supplierCategoryId ?? null,
        category_path_json: JSON.stringify(product.supplierCategoryPath ?? product.categoryPath ?? null),
        images_json: JSON.stringify(product.images ?? []),
        brand: product.brand ?? null,
        barcode: product.barcode ?? null,
        features_json: JSON.stringify(product.features ?? {}),
        raw_json: JSON.stringify(product.raw ?? null),
        updated_at: new Date()
      };
    });

    await upsertRows(this.requireDb(), "supplier_products", rows, "supplier_product_id");
  }

  private requireDb(): Knex {
    if (!this.db) {
      throw new Error("MySQL repository is disabled");
    }
    return this.db;
  }
}

export type CategorySettingsNode = {
  supplierCategoryKey: string;
  supplierCategoryId?: string;
  parentSupplierCategoryKey?: string;
  name: string;
  path: string[];
  enabled: boolean;
  markupPercent?: number;
  children: CategorySettingsNode[];
};

export type CategorySettingUpdate = {
  supplierCategoryKey: string;
  enabled: boolean;
  markupPercent?: number | null;
};

export type SyncRunStats = {
  totalReceived: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
};

export type CategoryRules = {
  enabledCategoryKeys: Set<string>;
  markupByCategoryKey: Map<string, number>;
};

function flattenCategories(categories: SupplierCategory[]): SupplierCategory[] {
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

function categoryKey(category: SupplierCategory): string {
  return category.id || categoryPathKey(category.path) || category.name;
}

function categoryPathKey(path?: string[]): string | null {
  return path?.length ? path.join(" > ") : null;
}

async function upsertRows(
  db: Knex,
  tableName: string,
  rows: Array<Record<string, unknown>>,
  key: string,
  mergeColumns?: string[]
): Promise<void> {
  if (rows.length === 0) return;
  for (const chunk of chunks(rows, 500)) {
    const query = db(tableName).insert(chunk).onConflict(key);
    if (mergeColumns) {
      await query.merge(mergeColumns);
    } else {
      await query.merge();
    }
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function mapCategorySettingsRow(row: Record<string, unknown>): CategorySettingsNode {
  const path = parseJsonArray(row.path_json);
  return {
    supplierCategoryKey: String(row.supplier_category_key),
    supplierCategoryId: row.supplier_category_id ? String(row.supplier_category_id) : undefined,
    parentSupplierCategoryKey: row.parent_supplier_category_key ? String(row.parent_supplier_category_key) : undefined,
    name: String(row.name),
    path,
    enabled: Boolean(row.enabled),
    markupPercent: row.markup_percent === null || row.markup_percent === undefined ? undefined : Number(row.markup_percent),
    children: []
  };
}

function buildSettingsTree(rows: CategorySettingsNode[]): CategorySettingsNode[] {
  const byKey = new Map(rows.map((row) => [row.supplierCategoryKey, row]));
  const roots: CategorySettingsNode[] = [];
  for (const row of rows) {
    const parent = row.parentSupplierCategoryKey ? byKey.get(row.parentSupplierCategoryKey) : undefined;
    if (parent) {
      parent.children.push(row);
    } else {
      roots.push(row);
    }
  }
  return roots;
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}
