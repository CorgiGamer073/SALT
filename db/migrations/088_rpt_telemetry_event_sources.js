'use strict';

const RPT_TELEMETRY_SQL = `
  CREATE TABLE IF NOT EXISTS rpt_telemetry_events (
    id BIGSERIAL PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    source_file TEXT NOT NULL,
    source_line BIGINT NOT NULL CHECK (source_line > 0),
    schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version > 0),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT rpt_telemetry_source_unique
      UNIQUE (server_id, event_type, source_file, source_line)
  );

  CREATE INDEX IF NOT EXISTS rpt_telemetry_server_type_time_idx
    ON rpt_telemetry_events (server_id, event_type, observed_at DESC)
    WHERE deleted_at IS NULL;

  CREATE INDEX IF NOT EXISTS rpt_telemetry_server_source_idx
    ON rpt_telemetry_events (server_id, source_file)
    WHERE deleted_at IS NULL;
`;

async function up(pool) {
  await pool.query(RPT_TELEMETRY_SQL);
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS rpt_telemetry_events');
}

module.exports = { up, down, RPT_TELEMETRY_SQL };
