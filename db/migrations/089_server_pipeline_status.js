'use strict';

const SERVER_PIPELINE_STATUS_SQL = `
  CREATE TABLE IF NOT EXISTS server_pipeline_status (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    pipeline TEXT NOT NULL CHECK (pipeline IN ('low_latency_adm', 'full_log_sync', 'feed_processor')),
    run_id UUID NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    state TEXT NOT NULL DEFAULT 'unknown'
      CHECK (state IN ('unknown', 'running', 'healthy', 'degraded', 'failed', 'disabled')),
    interval_seconds INTEGER CHECK (interval_seconds IS NULL OR interval_seconds > 0),
    last_attempt_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
    next_run_at TIMESTAMPTZ,
    error_code TEXT,
    counters JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (server_id, pipeline)
  );

  CREATE INDEX IF NOT EXISTS server_pipeline_status_state_due_idx
    ON server_pipeline_status (state, next_run_at);
`;

async function up(pool) {
  await pool.query(SERVER_PIPELINE_STATUS_SQL);
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS server_pipeline_status');
}

module.exports = { up, down, SERVER_PIPELINE_STATUS_SQL };
