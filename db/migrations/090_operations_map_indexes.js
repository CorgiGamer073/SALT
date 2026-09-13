'use strict';

const OPERATIONS_MAP_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_kill_events_server_timestamp_id
    ON kill_events (server_id, timestamp DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_player_death_events_server_timestamp_id
    ON player_death_events (server_id, timestamp DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_damage_events_server_timestamp_id
    ON damage_events (server_id, timestamp DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_territory_events_server_timestamp_id
    ON territory_events (server_id, timestamp DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_shop_orders_server_checkout_id
    ON shop_orders (server_id, checked_out_at DESC, id DESC)
    WHERE status = 'completed';

  CREATE INDEX IF NOT EXISTS idx_shop_order_items_order_id_id
    ON shop_order_items (order_id, id DESC);

  CREATE INDEX IF NOT EXISTS idx_faction_markers_server_map_updated_id
    ON faction_markers (server_id, LOWER(map_name), updated_at DESC, id DESC)
    WHERE server_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_spawn_exclusion_zones_server_evidence_id
    ON spawn_exclusion_zones (server_id, last_evidence_at DESC, id DESC);
`;

async function up(pool) {
  await pool.query(OPERATIONS_MAP_INDEX_SQL);
}

async function down(pool) {
  await pool.query(`
    DROP INDEX IF EXISTS idx_spawn_exclusion_zones_server_evidence_id;
    DROP INDEX IF EXISTS idx_faction_markers_server_map_updated_id;
    DROP INDEX IF EXISTS idx_shop_order_items_order_id_id;
    DROP INDEX IF EXISTS idx_shop_orders_server_checkout_id;
    DROP INDEX IF EXISTS idx_territory_events_server_timestamp_id;
    DROP INDEX IF EXISTS idx_damage_events_server_timestamp_id;
    DROP INDEX IF EXISTS idx_player_death_events_server_timestamp_id;
    DROP INDEX IF EXISTS idx_kill_events_server_timestamp_id;
  `);
}

module.exports = { up, down, OPERATIONS_MAP_INDEX_SQL };
