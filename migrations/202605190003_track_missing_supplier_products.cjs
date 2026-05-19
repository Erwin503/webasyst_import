exports.up = async function up(knex) {
  await knex.schema.alterTable("supplier_products", (table) => {
    table.boolean("is_active_supplier").notNullable().defaultTo(true).index();
    table.timestamp("last_seen_at").nullable().index();
    table.timestamp("missing_since").nullable();
    table.boolean("hidden_in_webasyst").notNullable().defaultTo(false).index();
    table.timestamp("hidden_in_webasyst_at").nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable("supplier_products", (table) => {
    table.dropColumn("hidden_in_webasyst_at");
    table.dropColumn("hidden_in_webasyst");
    table.dropColumn("missing_since");
    table.dropColumn("last_seen_at");
    table.dropColumn("is_active_supplier");
  });
};
