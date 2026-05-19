import { AppConfig } from "./config.js";
import { RawSupplierProduct } from "./supplierApi.js";
import { SupplierProduct, WebasystProduct, WebasystSku } from "./types.js";

const PREORDER_TEXT = "Товар доступен под заказ. Срок поставки уточняется после оформления заказа.";

export function normalizeSupplierProduct(raw: RawSupplierProduct): SupplierProduct {
  const descriptionFromCharacteristics = raw.adultCharacteristics?.["Описание"];
  const nameFromCharacteristics = raw.adultCharacteristics?.["Наименование"];
  const sku = String(raw.sku);
  const barcode = raw.barcodes?.split(",").map((item) => item.trim()).filter(Boolean)[0];
  const features: Record<string, string | number | boolean> = {
    supplier_category_id: raw.category,
    part: raw.part ?? "",
    multiplicity: raw.active.multiplicity ?? raw.multiplicity ?? 1,
    delivery_days: raw.active.delivery_days ?? 0
  };

  if (raw.vendor) features.vendor = raw.vendor;
  if (raw.warranty) features.warranty_months = raw.warranty;
  if (raw.weight !== undefined) features.weight = raw.weight;
  if (raw.volume !== undefined) features.volume = raw.volume;
  if (raw.active.qty !== undefined) features.supplier_qty_label = raw.active.qty;
  if (raw.active.nearest_logistic_center_qty !== undefined) {
    features.nearest_logistic_center_qty_label = raw.active.nearest_logistic_center_qty;
  }
  for (const [key, value] of Object.entries(raw.adultCharacteristics ?? {})) {
    if (key !== "Описание" && key !== "Наименование" && value !== "") {
      features[key] = value;
    }
  }

  return {
    id: sku,
    sku,
    name: raw.name || nameFromCharacteristics || sku,
    description: descriptionFromCharacteristics,
    price: Number(raw.active.price),
    oldPrice: raw.rrp ? Number(raw.rrp) : undefined,
    currency: "RUB",
    quantity: quantityLabelToApproxNumber(raw.active.qty),
    supplierCategoryId: String(raw.category),
    categoryName: raw.categoryPath?.at(-1),
    categoryPath: raw.categoryPath,
    supplierCategoryPath: raw.categoryPath,
    images: raw.imageUrls,
    brand: raw.vendor,
    barcode,
    features,
    raw
  };
}

export function mapSupplierToWebasyst(product: SupplierProduct, config: AppConfig, categoryId?: number, markupPercent?: number): WebasystProduct {
  const markup = markupPercent ?? config.priceMarkupPercent;
  const finalPrice = roundMoney(product.price * (1 + markup / 100));
  const stock = resolveStock(product, config);
  const sku: WebasystSku = {
    sku: product.sku || product.id,
    name: product.sku || product.id,
    available: 1,
    status: 1,
    price: finalPrice
  };

  if (product.oldPrice !== undefined && product.oldPrice > finalPrice) {
    sku.compare_price = roundMoney(product.oldPrice);
  }

  if (stock !== undefined) {
    sku.stock = { "0": stock };
  }

  const description = appendPreorderText(product.description ?? "", config.appendPreorderText);
  const params = [
    "preorder=1",
    `supplier_external_id=${escapeParamValue(product.id)}`,
    "supplier_source=external_api"
  ].join("\n");

  const webasyst: WebasystProduct = {
    name: product.name,
    type_id: config.webasyst.productTypeId,
    summary: product.shortDescription,
    description,
    status: 1,
    currency: product.currency || config.webasyst.currency,
    sku_type: 0,
    tags: config.preorderTag,
    params,
    features: mapFeatures(product),
    skus: {
      "0": sku
    }
  };

  webasyst.categories = [categoryId ?? config.webasyst.preorderRootCategoryId];

  return webasyst;
}

export function shouldSkipProduct(product: SupplierProduct): string | undefined {
  if (!product.name?.trim()) return "missing name";
  if (!product.price || !Number.isFinite(product.price) || product.price <= 0) return "missing or invalid price";
  return undefined;
}

function resolveStock(product: SupplierProduct, config: AppConfig): number | null | undefined {
  if (config.preorderStockMode === "null") {
    return undefined;
  }
  if (config.preorderStockMode === "fixed") {
    return config.preorderStockValue;
  }
  return product.quantity;
}

function appendPreorderText(description: string, append: boolean): string {
  if (!append) return description;
  if (description.includes(PREORDER_TEXT)) return description;
  return [description.trim(), PREORDER_TEXT].filter(Boolean).join("\n\n");
}

function mapFeatures(product: SupplierProduct): Record<string, string | number | boolean> {
  const features: Record<string, string | number | boolean> = {};
  if (product.brand) features.brand = product.brand;
  if (product.barcode) features.barcode = product.barcode;
  for (const [key, value] of Object.entries(product.features ?? {})) {
    if (value !== "" && value !== undefined) {
      features[sanitizeFeatureCode(key)] = value;
    }
  }
  return features;
}

function sanitizeFeatureCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9_]+/giu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function quantityLabelToApproxNumber(value?: string): number | undefined {
  if (value === "*") return 1;
  if (value === "**") return 10;
  if (value === "***") return 100;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function escapeParamValue(value: string): string {
  return value.replace(/\r?\n/g, " ");
}
