import fs from "node:fs/promises";
import path from "node:path";

export type CategoryMapEntry = {
  webasyst_category_id: number;
  name: string;
  parent_supplier_category_id?: string;
  updated_at: string;
};

export type CategoryMap = Record<string, CategoryMapEntry>;

export class CategoryMapStore {
  private map: CategoryMap = {};

  constructor(private readonly filePath: string) {}

  async load(): Promise<CategoryMap> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      if (!content.trim()) {
        this.map = {};
        return this.map;
      }
      this.map = JSON.parse(content) as CategoryMap;
      return this.map;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.map = {};
        await fs.writeFile(this.filePath, "{}\n", "utf8");
        return this.map;
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Category map JSON is corrupted: ${this.filePath}. Fix it manually; file was not overwritten.`);
      }
      throw error;
    }
  }

  get(supplierCategoryId: string): CategoryMapEntry | undefined {
    return this.map[supplierCategoryId];
  }

  set(supplierCategoryId: string, entry: Omit<CategoryMapEntry, "updated_at">): void {
    this.map[supplierCategoryId] = {
      ...entry,
      updated_at: new Date().toISOString()
    };
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(this.map, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, this.filePath);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
