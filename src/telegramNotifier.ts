import axios, { AxiosError } from "axios";
import fs from "node:fs/promises";
import path from "node:path";
import { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { SupplierProduct } from "./types.js";

type TelegramState = {
  supplierProductRequestCount: number;
  lastSupplierProductRequestAt?: string;
};

export type SupplierProductsLog = {
  source: string;
  products: SupplierProduct[];
  valid: number;
  skipped: number;
  importLimit?: number;
  dryRun: boolean;
  durationMs?: number;
};

export class TelegramNotifier {
  constructor(private readonly config: AppConfig) {}

  get enabled(): boolean {
    return Boolean(this.config.telegram.botToken && this.config.telegram.chatIds.length > 0);
  }

  async notifySupplierProductsFetched(log: SupplierProductsLog): Promise<void> {
    if (!this.enabled) return;

    try {
      const state = await this.loadState();
      state.supplierProductRequestCount += 1;
      state.lastSupplierProductRequestAt = new Date().toISOString();
      await this.saveState(state);

      const message = buildSupplierProductsMessage(log, state.supplierProductRequestCount);
      await this.sendMessage(message);
    } catch (error) {
      logger.warn("Telegram notification failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async sendMessage(text: string): Promise<void> {
    const token = this.config.telegram.botToken;
    if (!token) return;

    for (const chatId of this.config.telegram.chatIds) {
      try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true
        }, {
          timeout: 30_000
        });
      } catch (error) {
        throw enrichTelegramError(chatId, error);
      }
    }
  }

  private async loadState(): Promise<TelegramState> {
    await fs.mkdir(path.dirname(this.config.telegram.statePath), { recursive: true });
    try {
      const content = await fs.readFile(this.config.telegram.statePath, "utf8");
      if (!content.trim()) return { supplierProductRequestCount: 0 };
      return JSON.parse(content) as TelegramState;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { supplierProductRequestCount: 0 };
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Telegram state JSON is corrupted: ${this.config.telegram.statePath}`);
      }
      throw error;
    }
  }

  private async saveState(state: TelegramState): Promise<void> {
    await fs.mkdir(path.dirname(this.config.telegram.statePath), { recursive: true });
    const temporaryPath = `${this.config.telegram.statePath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, this.config.telegram.statePath);
  }
}

function buildSupplierProductsMessage(log: SupplierProductsLog, requestCount: number): string {
  return [
    "<b>\u0421\u0432\u0435\u0440\u043a\u0430 \u0442\u043e\u0432\u0430\u0440\u043e\u0432 \u043f\u043e\u0441\u0442\u0430\u0432\u0449\u0438\u043a\u0430</b>",
    `\u0418\u0441\u0442\u043e\u0447\u043d\u0438\u043a: ${escapeHtml(log.source)}`,
    `\u0417\u0430\u043f\u0440\u043e\u0441 \u2116: ${requestCount}`,
    `\u041f\u043e\u043b\u0443\u0447\u0435\u043d\u043e \u0442\u043e\u0432\u0430\u0440\u043e\u0432: ${log.products.length}`,
    `\u0412\u0430\u043b\u0438\u0434\u043d\u044b\u0445 \u043a \u0438\u043c\u043f\u043e\u0440\u0442\u0443: ${log.valid}`,
    `\u041f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043e: ${log.skipped}`,
    `IMPORT_LIMIT: ${log.importLimit ?? "\u043d\u0435 \u0437\u0430\u0434\u0430\u043d"}`,
    `DRY_RUN: ${log.dryRun ? "true" : "false"}`,
    log.durationMs === undefined ? undefined : `\u0412\u0440\u0435\u043c\u044f: ${Math.round(log.durationMs / 100) / 10} \u0441`
  ].filter((line): line is string => line !== undefined).join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function enrichTelegramError(chatId: string, error: unknown): Error {
  if (error instanceof AxiosError) {
    return new Error(`Telegram sendMessage failed for chat ${chatId}: HTTP ${error.response?.status ?? "n/a"} ${JSON.stringify(error.response?.data ?? error.message)}`);
  }
  return error instanceof Error ? error : new Error(`Telegram sendMessage failed for chat ${chatId}: ${String(error)}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
