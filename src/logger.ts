export const logger = {
  info(message: string, meta?: unknown): void {
    log("INFO", message, meta);
  },
  warn(message: string, meta?: unknown): void {
    log("WARN", message, meta);
  },
  error(message: string, meta?: unknown): void {
    log("ERROR", message, meta);
  },
  debug(message: string, meta?: unknown): void {
    if (process.env.DEBUG === "true") {
      log("DEBUG", message, meta);
    }
  }
};

function log(level: string, message: string, meta?: unknown): void {
  const line = `[${new Date().toISOString()}] ${level} ${message}`;
  if (meta === undefined) {
    console.log(line);
    return;
  }
  console.log(line, stringifyMeta(meta));
}

function stringifyMeta(meta: unknown): string {
  if (meta instanceof Error) {
    return meta.stack ?? meta.message;
  }
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}
