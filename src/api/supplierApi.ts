import axios, { AxiosError, AxiosInstance } from "axios";
import { AppConfig } from "../config/config.js";
import { logger } from "../config/logger.js";
import { SupplierCategory } from "../types/domain.js";

type JsonRpcRequest = {
  request: {
    method: string;
    model: string;
    module: string;
  };
  session?: string;
  data?: unknown;
  filter?: Array<Record<string, unknown>>;
  pager?: Record<string, unknown>;
  sort?: Array<Record<string, unknown>>;
};

type SupplierRpcResponse<T> = {
  success: boolean;
  message?: string;
  commandid?: number;
  data?: T;
  session?: string;
};

type CatalogProduct = {
  barcodes?: string;
  category: number;
  name: string;
  part?: string;
  multiplicity?: number;
  sku: number;
  vendor?: string;
  volume?: number;
  has_image?: boolean;
  rrp?: number;
  warranty?: string;
  weight?: number;
};

type CategoryNode = {
  id: number;
  leaf: boolean;
  name: string;
  childrens?: CategoryNode[];
};

type ActiveProduct = {
  price: number;
  qty?: string;
  nearest_logistic_center_qty?: string;
  sku: number;
  delivery_days?: number;
  multiplicity?: number;
};

type ImageRow = {
  id: number;
  sku: number;
  url: string;
  deleted?: boolean;
  priority?: number;
};

type AdultCharacteristic = {
  sku: number;
  characteristics: Array<{ name: string; value: string }>;
};

export type RawSupplierProduct = CatalogProduct & {
  active: ActiveProduct;
  imageUrls: string[];
  categoryPath?: string[];
  adultCharacteristics?: Record<string, string>;
};

export type DownloadedImage = {
  url: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
};

export class SupplierApi {
  private readonly http: AxiosInstance;
  private session?: string;
  private categoryTreeCache?: CategoryNode[];

  constructor(private readonly config: AppConfig) {
    this.http = axios.create({
      baseURL: config.supplier.baseUrl,
      timeout: 120_000,
      validateStatus: (status) => status >= 200 && status < 300
    });
  }

  async getCategories(): Promise<SupplierCategory[]> {
    await this.login();
    return categoryNodesToSupplierCategories(await this.getCategoryTree());
  }

  async getProducts(importLimit?: number): Promise<RawSupplierProduct[]> {
    await this.login();
    const [categories, catalogProducts, activeProducts, adultCharacteristics] = await Promise.all([
      this.getCategoryTree(),
      this.getCatalogProducts(),
      this.getActiveProducts(),
      this.getAdultCharacteristics()
    ]);

    const categoryPaths = buildCategoryPaths(categories);
    const catalogBySku = new Map(catalogProducts.map((product) => [String(product.sku), product]));
    const adultBySku = new Map(adultCharacteristics.map((row) => [String(row.sku), characteristicsToRecord(row)]));

    const merged: RawSupplierProduct[] = [];
    for (const active of activeProducts) {
      const catalog = catalogBySku.get(String(active.sku));
      if (!catalog) {
        logger.warn("Active supplier product is absent in static catalog, skipped", { sku: active.sku });
        continue;
      }

      merged.push({
        ...catalog,
        active,
        imageUrls: [],
        categoryPath: categoryPaths.get(catalog.category),
        adultCharacteristics: adultBySku.get(String(active.sku))
      });

      if (importLimit && merged.length >= importLimit) break;
    }

    return merged;
  }

  async getImageUrlsBySkus(skus: Array<string | number>): Promise<Map<string, string[]>> {
    await this.login();
    const uniqueSkus = [...new Set(skus.map((sku) => String(sku)).filter(Boolean))];
    const result = new Map<string, string[]>();
    if (uniqueSkus.length === 0) return result;

    logger.info("Fetching supplier image URLs", { products: uniqueSkus.length });
    for (const chunk of chunks(uniqueSkus.map(toSupplierSkuFilterValue), 100)) {
      const response = await this.rpc<{ product_images: ImageRow[]; total: number }>({
        request: {
          method: "read_new",
          model: "products_clients_images",
          module: "platform"
        },
        filter: [
          {
            operator: "IN",
            property: "sku",
            value: chunk
          }
        ]
      });

      const images = (response.data?.product_images ?? [])
        .filter((image) => !image.deleted)
        .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

      for (const image of images) {
        const key = String(image.sku);
        const urls = result.get(key) ?? [];
        urls.push(`${this.config.supplier.baseUrl}/${image.url.replace(/^\//, "")}?size=original`);
        result.set(key, urls);
      }

      await sleep(550);
    }

    return result;
  }

  async downloadImage(url: string): Promise<DownloadedImage> {
    if (!this.session) await this.login();
    const response = await this.http.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      headers: { Cookie: `session=${this.session}` }
    });

    const pathname = new URL(url).pathname;
    const filename = pathname.split("/").pop() || "supplier-image.jpg";
    return {
      url,
      filename,
      contentType: String(response.headers["content-type"] ?? "image/jpeg"),
      bytes: Buffer.from(response.data)
    };
  }

  private async login(): Promise<void> {
    if (this.session) return;
    const response = await this.rpc<{ session?: string }>({
      request: {
        method: "login",
        model: "auth",
        module: "quickfox"
      },
      data: {
        login: this.config.supplier.login,
        password: this.config.supplier.password
      }
    }, false);

    const session = response.session;
    if (!session) {
      throw new Error("Supplier authentication succeeded but session was not returned");
    }
    this.session = session;
    logger.info("Supplier authentication succeeded");
  }

  private async getCategoryTree(): Promise<CategoryNode[]> {
    if (this.categoryTreeCache) return this.categoryTreeCache;
    logger.info("Fetching supplier category tree from static catalog_tree_9.json");
    const response = await this.staticGet<CategoryNode[]>("/download/catalog/json/catalog_tree_9.json");
    this.categoryTreeCache = response;
    return response;
  }

  private async getCatalogProducts(): Promise<CatalogProduct[]> {
    logger.info("Fetching supplier static product catalog products_9.json");
    const response = await this.staticGet<CatalogProduct[]>("/download/catalog/json/products_9.json");
    return response;
  }

  private async getActiveProducts(): Promise<ActiveProduct[]> {
    logger.info("Fetching supplier active products with prices and stock");
    const response = await this.rpc<{ products: ActiveProduct[]; total: number }>({
      request: {
        method: "get_active_products",
        model: "client_api",
        module: "platform"
      }
    });
    return response.data?.products ?? [];
  }

  private async getAdultCharacteristics(): Promise<AdultCharacteristic[]> {
    logger.info("Fetching supplier 18+ product characteristics");
    try {
      const response = await this.rpc<{ adult_products_characteristics: AdultCharacteristic[]; total: number }>({
        request: {
          method: "get_adult_products_characteristics",
          model: "client_api",
          module: "platform"
        }
      });
      return response.data?.adult_products_characteristics ?? [];
    } catch (error) {
      logger.warn("Supplier 18+ characteristics endpoint is unavailable; continuing without adult characteristics", {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  private async staticGet<T>(path: string): Promise<T> {
    if (!this.session) {
      throw new Error("Supplier session is required before static catalog request");
    }
    try {
      const response = await this.http.get<T>(path, {
        headers: { Cookie: `session=${this.session}` }
      });
      return response.data;
    } catch (error) {
      throw enrichAxiosError("Supplier static request failed", error);
    }
  }

  private async rpc<T>(payload: JsonRpcRequest, withSession = true): Promise<SupplierRpcResponse<T>> {
    const body: JsonRpcRequest = { ...payload };
    if (withSession) {
      if (!this.session) {
        throw new Error("Supplier session is required before JSON-RPC request");
      }
      body.session = this.session;
    }

    try {
      const response = await this.http.post<SupplierRpcResponse<T>>("/api/2", body, {
        headers: { "Content-Type": "application/json" }
      });
      if (!response.data.success) {
        throw new Error(`Supplier API error: ${response.data.message ?? "unknown error"}; commandid=${response.data.commandid ?? "n/a"}`);
      }
      return response.data;
    } catch (error) {
      throw enrichAxiosError("Supplier JSON-RPC request failed", error);
    }
  }
}

function buildCategoryPaths(categories: CategoryNode[]): Map<number, string[]> {
  const result = new Map<number, string[]>();
  const walk = (node: CategoryNode, parents: string[]) => {
    const path = [...parents, node.name];
    result.set(node.id, path);
    for (const child of node.childrens ?? []) {
      walk(child, path);
    }
  };
  for (const category of categories) {
    walk(category, []);
  }
  return result;
}

function categoryNodesToSupplierCategories(categories: CategoryNode[]): SupplierCategory[] {
  const walk = (node: CategoryNode, parents: string[], parentId?: string): SupplierCategory => {
    const id = String(node.id);
    const path = [...parents, node.name];
    return {
      id,
      name: node.name,
      parentId,
      path,
      children: (node.childrens ?? []).map((child) => walk(child, path, id)),
      raw: node
    };
  };

  return categories.map((category) => walk(category, []));
}

function characteristicsToRecord(row: AdultCharacteristic): Record<string, string> {
  return Object.fromEntries(row.characteristics.map((item) => [item.name, item.value]));
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function toSupplierSkuFilterValue(sku: string): string | number {
  return /^\d+$/.test(sku) ? Number(sku) : sku;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enrichAxiosError(message: string, error: unknown): Error {
  if (error instanceof AxiosError) {
    return new Error(`${message}: HTTP ${error.response?.status ?? "n/a"} ${JSON.stringify(error.response?.data ?? error.message)}`);
  }
  return error instanceof Error ? error : new Error(`${message}: ${String(error)}`);
}
