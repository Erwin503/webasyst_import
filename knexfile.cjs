require("dotenv/config");

module.exports = {
  client: "mysql2",
  connection: {
    host: env("MYSQL_HOST", "127.0.0.1"),
    port: Number(env("MYSQL_PORT", "3306")),
    database: required("MYSQL_DATABASE"),
    user: required("MYSQL_USER"),
    password: env("MYSQL_PASSWORD", ""),
    ssl: truthy(env("MYSQL_SSL", "false")) ? {} : undefined
  },
  migrations: {
    directory: "./migrations",
    extension: "cjs"
  }
};

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function env(name, fallback) {
  return process.env[name]?.trim() || fallback;
}

function truthy(value) {
  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
}
