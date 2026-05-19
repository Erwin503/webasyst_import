exports.up = async function up(knex) {
  await knex.schema.alterTable("supplier_categories", (table) => {
    table.boolean("enabled").notNullable().defaultTo(false).index();
    table.decimal("markup_percent", 8, 2).nullable();
  });

  await knex.schema.createTable("sync_settings", (table) => {
    table.string("setting_key", 128).primary();
    table.text("setting_value").nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("sync_runs", (table) => {
    table.increments("id").primary();
    table.string("source", 64).notNullable();
    table.string("status", 32).notNullable();
    table.integer("total_received").notNullable().defaultTo(0);
    table.integer("created_count").notNullable().defaultTo(0);
    table.integer("updated_count").notNullable().defaultTo(0);
    table.integer("skipped_count").notNullable().defaultTo(0);
    table.integer("error_count").notNullable().defaultTo(0);
    table.text("error_message").nullable();
    table.timestamp("started_at").notNullable().defaultTo(knex.fn.now());
    table.timestamp("finished_at").nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists("sync_runs");
  await knex.schema.dropTableIfExists("sync_settings");
  await knex.schema.alterTable("supplier_categories", (table) => {
    table.dropColumn("markup_percent");
    table.dropColumn("enabled");
  });
};
