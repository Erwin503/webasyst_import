exports.up = async function up(knex) {
  await knex.schema.alterTable("supplier_categories", (table) => {
    table.integer("webasyst_category_id").nullable().index();
    table.timestamp("webasyst_synced_at").nullable();
  });

  await knex.schema.alterTable("supplier_products", (table) => {
    table.integer("webasyst_product_id").nullable().index();
    table.timestamp("webasyst_synced_at").nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable("supplier_products", (table) => {
    table.dropColumn("webasyst_synced_at");
    table.dropColumn("webasyst_product_id");
  });

  await knex.schema.alterTable("supplier_categories", (table) => {
    table.dropColumn("webasyst_synced_at");
    table.dropColumn("webasyst_category_id");
  });
};
