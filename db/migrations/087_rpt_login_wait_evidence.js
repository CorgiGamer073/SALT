'use strict';

const RPT_LOGIN_WAIT_EVIDENCE_SQL = `
  CREATE TABLE IF NOT EXISTS rpt_login_wait_events (
    id BIGSERIAL PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    identity_id INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,
    queue_entered_at TIMESTAMPTZ,
    wait_started_at TIMESTAMPTZ NOT NULL,
    wait_ended_at TIMESTAMPTZ NOT NULL,
    wait_duration_ms BIGINT GENERATED ALWAYS AS (
      (EXTRACT(EPOCH FROM (wait_ended_at - wait_started_at)) * 1000)::BIGINT
    ) STORED,
    source_file TEXT NOT NULL,
    source_line INTEGER NOT NULL CHECK (source_line > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (wait_ended_at >= wait_started_at),
    UNIQUE (server_id, source_file, source_line)
  );

  CREATE INDEX IF NOT EXISTS idx_rpt_login_wait_events_candidate_lookup
    ON rpt_login_wait_events (server_id, identity_id, queue_entered_at)
    INCLUDE (wait_duration_ms)
    WHERE queue_entered_at IS NOT NULL AND wait_duration_ms >= 60000;

  CREATE INDEX IF NOT EXISTS idx_player_sessions_server_logout_alt_lookup
    ON player_sessions (server_id, logout_at DESC)
    INCLUDE (identity_id)
    WHERE logout_at IS NOT NULL;
`;

async function up(pool) {
  await pool.query(RPT_LOGIN_WAIT_EVIDENCE_SQL);
}

async function down(pool) {
  await pool.query('DROP INDEX IF EXISTS idx_player_sessions_server_logout_alt_lookup');
  await pool.query('DROP TABLE IF EXISTS rpt_login_wait_events');
}

module.exports = { up, down, RPT_LOGIN_WAIT_EVIDENCE_SQL };
