import "dotenv/config";
import path from "node:path";

export type PreorderStockMode = "null" | "fixed" | "supplier";
export type SupplierCategoryMode = "single" | "mirror";

export type AppConfig = {
  supplier: {
    baseUrl: string;
    apiToken?: string;
    login: string;
    password: string;
  };
  webasyst: {
    apiUrl: string;
    accessToken: string;
    defaultCategoryId?: number;
    preorderRootCategoryId: number;
    productTypeId: number;
    currency: string;
  };
  supplierCategoryMode: SupplierCategoryMode;
  priceMarkupPercent: number;
  importLimit?: number;
  dryRun: boolean;
  appendPreorderText: boolean;
  preorderTag: string;
  preorderStockMode: PreorderStockMode;
  preorderStockValue: number;
  productMapPath: string;
  categoryMapPath: string;
};

export function loadConfig(): AppConfig {
  const supplierBaseUrl = required("SUPPLIER_API_URL").replace(/\/api\/2\/?$/, "").replace(/\/$/, "");
  const webasystApiUrl = required("WEBASYST_API_URL").replace(/\/$/, "");

  return {
    supplier: {
      baseUrl: supplierBaseUrl,
      apiToken: optional("SUPPLIER_API_TOKEN"),
      login: required("SUPPLIER_API_LOGIN"),
      password: required("SUPPLIER_API_PASSWORD")
    },
    webasyst: {
      apiUrl: webasystApiUrl,
      accessToken: required("WEBASYST_ACCESS_TOKEN"),
      defaultCategoryId: optionalNumber("WEBASYST_DEFAULT_CATEGORY_ID"),
      preorderRootCategoryId: requiredNumber("WEBASYST_PREORDER_ROOT_CATEGORY_ID"),
      productTypeId: numberEnv("WEBASYST_PRODUCT_TYPE_ID", 1),
      currency: optional("WEBASYST_CURRENCY") ?? "RUB"
    },
    supplierCategoryMode: categoryModeEnv("SUPPLIER_CATEGORY_MODE", "single"),
    priceMarkupPercent: numberEnv("PRICE_MARKUP_PERCENT", 0),
    importLimit: optionalNumber("IMPORT_LIMIT"),
    dryRun: booleanEnv("DRY_RUN", true),
    appendPreorderText: booleanEnv("APPEND_PREORDER_TEXT", false),
    preorderTag: optional("PREORDER_TAG") ?? "\u043f\u043e\u0434 \u0437\u0430\u043a\u0430\u0437",
    preorderStockMode: stockModeEnv("PREORDER_STOCK_MODE", "null"),
    preorderStockValue: numberEnv("PREORDER_STOCK_VALUE", 999),
    productMapPath: path.resolve(process.cwd(), "data", "product-map.json"),
    categoryMapPath: path.resolve(process.cwd(), "data", "category-map.json")
  };
}

export function loadSupplierOnlyConfig(): AppConfig {
  const supplierBaseUrl = required("SUPPLIER_API_URL").replace(/\/api\/2\/?$/, "").replace(/\/$/, "");

  return {
    supplier: {
      baseUrl: supplierBaseUrl,
      apiToken: optional("SUPPLIER_API_TOKEN"),
      login: required("SUPPLIER_API_LOGIN"),
      password: required("SUPPLIER_API_PASSWORD")
    },
    webasyst: {
      apiUrl: optional("WEBASYST_API_URL") ?? "https://example.webasyst.cloud/api.php",
      accessToken: optional("WEBASYST_ACCESS_TOKEN") ?? "",
      defaultCategoryId: optionalNumber("WEBASYST_DEFAULT_CATEGORY_ID"),
      preorderRootCategoryId: optionalNumber("WEBASYST_PREORDER_ROOT_CATEGORY_ID") ?? 0,
      productTypeId: numberEnv("WEBASYST_PRODUCT_TYPE_ID", 1),
      currency: optional("WEBASYST_CURRENCY") ?? "RUB"
    },
    supplierCategoryMode: categoryModeEnv("SUPPLIER_CATEGORY_MODE", "single"),
    priceMarkupPercent: numberEnv("PRICE_MARKUP_PERCENT", 0),
    importLimit: optionalNumber("IMPORT_LIMIT"),
    dryRun: true,
    appendPreorderText: booleanEnv("APPEND_PREORDER_TEXT", false),
    preorderTag: optional("PREORDER_TAG") ?? "\u043f\u043e\u0434 \u0437\u0430\u043a\u0430\u0437",
    preorderStockMode: stockModeEnv("PREORDER_STOCK_MODE", "null"),
    preorderStockValue: numberEnv("PREORDER_STOCK_VALUE", 999),
    productMapPath: path.resolve(process.cwd(), "data", "product-map.json"),
    categoryMapPath: path.resolve(process.cwd(), "data", "category-map.json")
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function optionalNumber(name: string): number | undefined {
  const value = optional(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return parsed;
}

function requiredNumber(name: string): number {
  const value = optionalNumber(name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function numberEnv(name: string, fallback: number): number {
  return optionalNumber(name) ?? fallback;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = optional(name);
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
}

function stockModeEnv(name: string, fallback: PreorderStockMode): PreorderStockMode {
  const value = (optional(name) ?? fallback).toLowerCase();
  if (value === "null" || value === "fixed" || value === "supplier") {
    return value;
  }
  throw new Error(`${name} must be one of: null, fixed, supplier`);
}

function categoryModeEnv(name: string, fallback: SupplierCategoryMode): SupplierCategoryMode {
  const value = (optional(name) ?? fallback).toLowerCase();
  if (value === "single" || value === "mirror") {
    return value;
  }
  throw new Error(`${name} must be one of: single, mirror`);
}
