import axios, { AxiosError, AxiosInstance } from "axios";
import { AppConfig } from "./config.js";
import { DownloadedImage } from "./supplierApi.js";
import { WebasystCategory, WebasystProduct } from "./types.js";

type WebasystResponse = {
  status?: "ok" | "fail";
  data?: unknown;
  error?: string;
  error_description?: string;
  id?: number;
  [key: string]: unknown;
};

export type WebasystCategoryTreeItem = {
  id: number;
  parent_id: number;
  name: string;
  url?: string;
  status?: number;
  include_sub_categories?: number;
  categories?: WebasystCategoryTreeItem[];
  children?: WebasystCategoryTreeItem[];
};

export type WebasystProductSearchItem = {
  id: number | string;
  name?: string;
  params?: string;
  skus?: Array<{
    id?: number | string;
    product_id?: number | string;
    sku?: string | number;
  }> | Record<string, {
    id?: number | string;
    product_id?: number | string;
    sku?: string | number;
  }>;
};

export class WebasystApi {
  private readonly http: AxiosInstance;

  constructor(private readonly config: AppConfig) {
    this.http = axios.create({
      timeout: 120_000,
      validateStatus: (status) => status >= 200 && status < 300
    });
  }

  async createProduct(product: WebasystProduct): Promise<number | undefined> {
    const response = await this.postForm("shop.product.add", product);
    return extractId(response);
  }

  async updateProduct(productId: number, product: WebasystProduct): Promise<number | undefined> {
    const response = await this.postForm("shop.product.update", product, { id: String(productId) });
    return extractId(response) ?? productId;
  }

  async findProductBySupplierIdentity(externalId: string, sku: string): Promise<number | undefined> {
    const candidates = await this.searchProductsBySku(sku);
    const exact = candidates.find((product) => {
      return productContainsSku(product, sku) || productContainsExternalId(product, externalId);
    });
    return exact ? toNumberId(exact.id) : undefined;
  }

  async addProductImage(productId: number, image: DownloadedImage): Promise<void> {
    const form = new FormData();
    const bytes = new Uint8Array(image.bytes);
    const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)], { type: image.contentType });
    form.append("file", blob, image.filename);

    await this.postMultipart("shop.product.images.add", form, { product_id: String(productId) });
  }

  async createCategory(category: WebasystCategory): Promise<number | undefined> {
    const response = await this.postForm("shop.category.add", category);
    return extractId(response) ?? failMissingId("shop.category.add", response);
  }

  async updateCategory(categoryId: number, category: WebasystCategory): Promise<number | undefined> {
    const response = await this.postForm("shop.category.update", category, { id: String(categoryId) });
    return extractId(response) ?? categoryId;
  }

  async getCategoryTree(parentId: number): Promise<WebasystCategoryTreeItem[]> {
    const response = await this.getJson("shop.category.getTree", {
      parent_id: String(parentId)
    });
    return extractArray<WebasystCategoryTreeItem>(response);
  }

  private async searchProductsBySku(sku: string): Promise<WebasystProductSearchItem[]> {
    const hashes = [
      `search/sku=${encodeURIComponent(sku)}`,
      `search/query=${encodeURIComponent(sku)}`
    ];
    const found: WebasystProductSearchItem[] = [];
    const seen = new Set<number>();

    for (const hash of hashes) {
      const response = await this.getJson("shop.product.search", {
        hash,
        limit: "20",
        fields: "*,skus"
      });
      for (const product of extractArray<WebasystProductSearchItem>(response)) {
        const id = toNumberId(product.id);
        if (id === undefined || seen.has(id)) continue;
        seen.add(id);
        found.push(product);
      }
    }

    return found;
  }

  private async postForm(method: string, payload: Record<string, unknown>, query: Record<string, string> = {}): Promise<WebasystResponse> {
    const url = this.methodUrl(method, query);
    const body = new URLSearchParams();
    appendForm(body, payload);

    try {
      const response = await this.http.post<WebasystResponse>(url, body, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      });
      assertWebasystOk(response.data);
      return response.data;
    } catch (error) {
      throw enrichAxiosError(`Webasyst ${method} failed`, error);
    }
  }

  private async postMultipart(method: string, form: FormData, query: Record<string, string>): Promise<WebasystResponse> {
    const url = this.methodUrl(method, query);
    try {
      const response = await this.http.post<WebasystResponse>(url, form);
      assertWebasystOk(response.data);
      return response.data;
    } catch (error) {
      throw enrichAxiosError(`Webasyst ${method} failed`, error);
    }
  }

  private async getJson(method: string, query: Record<string, string> = {}): Promise<WebasystResponse> {
    const url = this.methodUrl(method, query);
    try {
      const response = await this.http.get<WebasystResponse>(url);
      assertWebasystOk(response.data);
      return response.data;
    } catch (error) {
      throw enrichAxiosError(`Webasyst ${method} failed`, error);
    }
  }

  private methodUrl(method: string, query: Record<string, string> = {}): string {
    const url = new URL(`${this.config.webasyst.apiUrl}/${method}`);
    url.searchParams.set("access_token", this.config.webasyst.accessToken);
    url.searchParams.set("format", "json");
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
}

function appendForm(body: URLSearchParams, value: unknown, prefix?: string): void {
  if (value === undefined) return;
  if (value === null) {
    if (prefix) body.append(prefix, "");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendForm(body, item, `${prefix ?? ""}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      appendForm(body, nestedValue, prefix ? `${prefix}[${key}]` : key);
    }
    return;
  }
  if (!prefix) {
    throw new Error("Cannot append scalar form value without a key");
  }
  body.append(prefix, String(value));
}

function extractId(response: WebasystResponse): number | undefined {
  const data = response.data;
  const responseId = toNumberId(response.id);
  if (responseId !== undefined) return responseId;
  const dataId = toNumberId(data);
  if (dataId !== undefined) return dataId;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const directId = toNumberId(record.id) ?? toNumberId(record.product_id) ?? toNumberId(record.category_id);
    if (directId !== undefined) return directId;
    for (const key of ["product", "category"]) {
      if (record[key] && typeof record[key] === "object") {
        const nested = record[key] as Record<string, unknown>;
        const nestedId = toNumberId(nested.id);
        if (nestedId !== undefined) return nestedId;
      }
    }
  }
  return undefined;
}

function toNumberId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function failMissingId(method: string, response: WebasystResponse): never {
  throw new Error(`${method} response did not contain numeric id: ${JSON.stringify(response)}`);
}

function extractArray<T>(response: WebasystResponse): T[] {
  if (Array.isArray(response.data)) return response.data as T[];
  if (Array.isArray(response)) return response as T[];
  if (response.data && typeof response.data === "object") {
    const record = response.data as Record<string, unknown>;
    if (Array.isArray(record.categories)) return record.categories as T[];
    if (Array.isArray(record.products)) return record.products as T[];
  }
  return [];
}

function productContainsSku(product: WebasystProductSearchItem, sku: string): boolean {
  const skus = product.skus;
  if (!skus) return false;
  const values = Array.isArray(skus) ? skus : Object.values(skus);
  return values.some((item) => String(item.sku ?? "") === sku);
}

function productContainsExternalId(product: WebasystProductSearchItem, externalId: string): boolean {
  return typeof product.params === "string" && product.params.includes(`supplier_external_id=${externalId}`);
}

function assertWebasystOk(response: WebasystResponse): void {
  if (response.status === "fail" || response.error) {
    throw new Error(`${response.error ?? "webasyst_error"}: ${response.error_description ?? JSON.stringify(response)}`);
  }
}

function enrichAxiosError(message: string, error: unknown): Error {
  if (error instanceof AxiosError) {
    return new Error(`${message}: HTTP ${error.response?.status ?? "n/a"} ${JSON.stringify(error.response?.data ?? error.message)}`);
  }
  return error instanceof Error ? error : new Error(`${message}: ${String(error)}`);
}
