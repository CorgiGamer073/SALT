'use strict';

const LOW_LATENCY_ADM_CURSORS_SQL = `
  CREATE TABLE IF NOT EXISTS low_latency_adm_cursors (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    remote_path TEXT NOT NULL,
    remote_name TEXT NOT NULL,
    byte_offset BIGINT NOT NULL CHECK (byte_offset >= 0),
    source_line_base BIGINT NOT NULL CHECK (source_line_base >= 0),
    previous_line_timestamp TIMESTAMPTZ,
    content_fingerprint TEXT NOT NULL CHECK (content_fingerprint ~ '^[a-f0-9]{64}$'),
    remote_size BIGINT NOT NULL CHECK (remote_size >= byte_offset),
    remote_modified_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (server_id, remote_path)
  );

  CREATE INDEX IF NOT EXISTS low_latency_adm_cursors_updated_idx
    ON low_latency_adm_cursors(updated_at);
`;

async function up(pool) {
  await pool.query(LOW_LATENCY_ADM_CURSORS_SQL);
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS low_latency_adm_cursors');
}

module.exports = { up, down, LOW_LATENCY_ADM_CURSORS_SQL };
