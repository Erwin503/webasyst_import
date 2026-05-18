export type SupplierProduct = {
  id: string;
  sku: string;
  name: string;
  description?: string;
  shortDescription?: string;
  price: number;
  oldPrice?: number;
  currency?: string;
  quantity?: number;
  supplierCategoryId?: string;
  categoryName?: string;
  categoryPath?: string[];
  supplierCategoryPath?: string[];
  images?: string[];
  brand?: string;
  barcode?: string;
  features?: Record<string, string | number | boolean>;
  raw?: unknown;
};

export type SupplierCategory = {
  id: string;
  name: string;
  parentId?: string;
  path: string[];
  children: SupplierCategory[];
  raw?: unknown;
};

export type WebasystCategory = {
  name: string;
  parent_id: number;
  url: string;
  status: 1;
  include_sub_categories: 0 | 1;
};

export type WebasystProduct = {
  name: string;
  type_id: number;
  summary?: string;
  description?: string;
  status: 1;
  currency: string;
  sku_type: 0;
  categories?: number[];
  tags: string;
  params: string;
  features?: Record<string, string | number | boolean>;
  skus: Record<string, WebasystSku>;
};

export type WebasystSku = {
  sku: string;
  name: string;
  available: 1;
  status: 1;
  price: number;
  compare_price?: number;
  stock?: Record<string, number | null>;
};
