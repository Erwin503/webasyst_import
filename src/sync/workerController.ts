import { AppConfig } from "../config/config.js";
import { logger } from "../config/logger.js";
import { createDb } from "../db/db.js";
import { SupplierDataRepository } from "../repositories/supplierDataRepository.js";
import { SyncStats, syncProducts } from "./syncProducts.js";

export type WorkerStatus = {
  running: boolean;
  activeRun: boolean;
  intervalHours: number;
  startTime?: string;
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
    const startTime = await this.getStartTime();
    if (startTime) {
      await this.scheduleInitialStart(startTime);
      return;
    }
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

  async setStartTime(startTime?: string): Promise<void> {
    const normalized = normalizeStartTime(startTime);
    const repo = new SupplierDataRepository(createDb(this.config));
    try {
      await repo.setSetting("supplier_sync_start_time", normalized ?? "");
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

  async getStartTime(): Promise<string | undefined> {
    const repo = new SupplierDataRepository(createDb(this.config));
    try {
      return normalizeStartTime(await repo.getSetting("supplier_sync_start_time"));
    } finally {
      await repo.destroy();
    }
  }

  async status(): Promise<WorkerStatus> {
    return {
      running: Boolean(this.timer),
      activeRun: this.activeRun,
      intervalHours: this.config.supplierSyncIntervalHours,
      startTime: await this.getStartTime(),
      nextRunAt: this.nextRunAt?.toISOString(),
      lastRunAt: this.lastRunAt?.toISOString(),
      lastStats: this.lastStats,
      lastError: this.lastError
    };
  }

  private async scheduleFromSettings(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    const startTime = await this.getStartTime();
    if (!this.lastRunAt && startTime) {
      await this.scheduleInitialStart(startTime);
      return;
    }
    const intervalHours = await this.getIntervalHours();
    this.config.supplierSyncIntervalHours = intervalHours;
    const delayMs = intervalHours * 60 * 60 * 1000;
    this.nextRunAt = new Date(Date.now() + delayMs);
    this.timer = setTimeout(() => {
      void this.runNow("worker-interval");
    }, delayMs);
  }

  private async scheduleInitialStart(startTime: string): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    const delayMs = millisecondsUntilStartTime(startTime);
    this.nextRunAt = new Date(Date.now() + delayMs);
    this.timer = setTimeout(() => {
      void this.runNow("worker-start-time");
    }, delayMs);
  }
}

function normalizeStartTime(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(trimmed);
  if (!match) {
    throw new Error("startTime must be in HH:mm format");
  }
  return `${match[1]}:${match[2]}`;
}

function millisecondsUntilStartTime(startTime: string): number {
  const [hours, minutes] = startTime.split(":").map(Number);
  const next = new Date();
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= Date.now()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - Date.now();
}
