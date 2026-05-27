#!/usr/bin/env node

const { spawn } = require("node:child_process");
const path = require("node:path");
const dotenv = require("dotenv");
const knex = require("knex");
const knexConfig = require("./knexfile.cjs");

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

main().catch((error) => {
  console.error("[entrypoint] Fatal error", error);
  process.exit(1);
});

async function main() {
  if (truthy(process.env.MYSQL_ENABLED)) {
    console.log("[entrypoint] MYSQL_ENABLED=true, running migrations");
    const db = knex(knexConfig);
    try {
      await db.migrate.latest();
      console.log("[entrypoint] Migrations are up to date");
    } finally {
      await db.destroy();
    }
  } else {
    console.log("[entrypoint] MYSQL_ENABLED is not true, skipping migrations");
  }

  const command = process.argv.slice(2);
  if (command.length === 0) {
    console.error("[entrypoint] No command provided");
    process.exit(1);
  }

  const child = spawn(command[0], command.slice(1), {
    stdio: "inherit"
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

function truthy(value) {
  return ["1", "true", "yes", "y"].includes(String(value ?? "").toLowerCase());
}
