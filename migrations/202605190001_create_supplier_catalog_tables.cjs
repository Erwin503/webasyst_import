exports.up = async function up(knex) {
  await knex.schema.createTable("supplier_categories", (table) => {
    table.string("supplier_category_key", 255).primary();
    table.string("supplier_category_id", 64).nullable().index();
    table.string("parent_supplier_category_key", 255).nullable().index();
    table.string("name", 512).notNullable();
    table.json("path_json").notNullable();
    table.json("raw_json").nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("supplier_products", (table) => {
    table.string("supplier_product_id", 64).primary();
    table.string("sku", 128).notNullable().index();
    table.string("name", 1024).notNullable();
    table.decimal("price", 15, 2).notNullable();
    table.decimal("old_price", 15, 2).nullable();
    table.string("currency", 16).nullable();
    table.integer("quantity").nullable();
    table.string("supplier_category_key", 255).nullable().index();
    table.string("supplier_category_id", 64).nullable().index();
    table.json("category_path_json").nullable();
    table.json("images_json").nullable();
    table.string("brand", 255).nullable();
    table.string("barcode", 255).nullable();
    table.json("features_json").nullable();
    table.json("raw_json").nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists("supplier_products");
  await knex.schema.dropTableIfExists("supplier_categories");
};
