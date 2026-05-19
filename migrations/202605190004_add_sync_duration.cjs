exports.up = async function up(knex) {
  await knex.schema.alterTable("sync_runs", (table) => {
    table.integer("duration_ms").nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable("sync_runs", (table) => {
    table.dropColumn("duration_ms");
  });
};
