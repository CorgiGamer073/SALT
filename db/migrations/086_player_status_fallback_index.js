'use strict';

const PLAYER_STATUS_FALLBACK_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_player_position_snapshots_status_fallback
    ON player_position_snapshots (server_id, timestamp DESC, id DESC)
    INCLUDE (identity_id, player_gamertag)
    WHERE identity_id IS NOT NULL;
`;

async function up(pool) {
  await pool.query(PLAYER_STATUS_FALLBACK_INDEX_SQL);
}

async function down(pool) {
  await pool.query('DROP INDEX IF EXISTS idx_player_position_snapshots_status_fallback');
}

module.exports = { up, down, PLAYER_STATUS_FALLBACK_INDEX_SQL };
