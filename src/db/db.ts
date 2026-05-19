import knex, { Knex } from "knex";
import { AppConfig } from "../config/config.js";

export function createDb(config: AppConfig): Knex | undefined {
  if (!config.database.enabled) return undefined;

  const { host, port, database, user, password, ssl } = config.database;
  if (!host || !database || !user) {
    throw new Error("MySQL is enabled, but MYSQL_HOST, MYSQL_DATABASE, or MYSQL_USER is missing");
  }

  return knex({
    client: "mysql2",
    connection: {
      host,
      port,
      database,
      user,
      password,
      ssl: ssl ? {} : undefined
    },
    pool: {
      min: 0,
      max: 5
    }
  });
}
