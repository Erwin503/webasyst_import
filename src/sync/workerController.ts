import { AppConfig } from "../config/config.js";
import { logger } from "../config/logger.js";
import { createDb } from "../db/db.js";
import { SupplierDataRepository } from "../repositories/supplierDataRepository.js";
import { SyncStats, syncProducts } from "./syncProducts.js";

export type WorkerStatus = {
  running: boolean;
  activeRun: boolean;
  intervalHours: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStats?: SyncStats;
  lastError?: string;
};

export class WorkerController {
  private timer?: NodeJS.Timeout;
  private activeRun = false;
  private nextRunAt?: Date;
  private lastRunAt?: Date;
  private lastStats?: SyncStats;
  private lastError?: string;

  constructor(private readonly config: AppConfig) {}

  async start(): Promise<void> {
    if (this.timer) return;
    await this.scheduleFromSettings();
    void this.runNow("worker-start");
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.nextRunAt = undefined;
  }

  async runNow(source = "manual"): Promise<SyncStats | undefined> {
    if (this.activeRun) {
      logger.warn("Sync run skipped because previous run is still active", { source });
      return undefined;
    }

    this.activeRun = true;
    this.lastRunAt = new Date();
    this.lastError = undefined;

    const repo = new SupplierDataRepository(createDb(this.config));
    const runId = await repo.createSyncRun(source);
    try {
      const stats = await syncProducts(this.config);
      this.lastStats = stats;
      await repo.finishSyncRun(runId, stats.errors > 0 ? "failed" : "success", stats);
      return stats;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await repo.finishSyncRun(runId, "failed", undefined, error);
      throw error;
    } finally {
      await repo.destroy();
      this.activeRun = false;
      if (this.timer) {
        await this.scheduleFromSettings();
      }
    }
  }

  async setIntervalHours(intervalHours: number): Promise<void> {
    if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
      throw new Error("intervalHours must be a positive number");
    }
    this.config.supplierSyncIntervalHours = intervalHours;
    const repo = new SupplierDataRepository(createDb(this.config));
    try {
      await repo.setSetting("supplier_sync_interval_hours", String(intervalHours));
    } finally {
      await repo.destroy();
    }
    if (this.timer) {
      await this.scheduleFromSettings();
    }
  }

  async getIntervalHours(): Promise<number> {
    const repo = new SupplierDataRepository(createDb(this.config));
    try {
      const value = await repo.getSetting("supplier_sync_interval_hours");
      const parsed = value ? Number(value) : NaN;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : this.config.supplierSyncIntervalHours;
    } finally {
      await repo.destroy();
    }
  }

  status(): WorkerStatus {
    return {
      running: Boolean(this.timer),
      activeRun: this.activeRun,
      intervalHours: this.config.supplierSyncIntervalHours,
      nextRunAt: this.nextRunAt?.toISOString(),
      lastRunAt: this.lastRunAt?.toISOString(),
      lastStats: this.lastStats,
      lastError: this.lastError
    };
  }

  private async scheduleFromSettings(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    const intervalHours = await this.getIntervalHours();
    this.config.supplierSyncIntervalHours = intervalHours;
    const delayMs = intervalHours * 60 * 60 * 1000;
    this.nextRunAt = new Date(Date.now() + delayMs);
    this.timer = setTimeout(() => {
      void this.runNow("worker-interval");
    }, delayMs);
  }
}
