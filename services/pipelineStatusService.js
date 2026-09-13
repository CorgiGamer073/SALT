'use strict';

const { randomUUID } = require('crypto');

const PIPELINES = Object.freeze({
  LOW_LATENCY_ADM: 'low_latency_adm',
  FULL_LOG_SYNC: 'full_log_sync',
  FEED_PROCESSOR: 'feed_processor',
});
const PIPELINE_VALUES = new Set(Object.values(PIPELINES));
const TERMINAL_STATES = new Set(['healthy', 'degraded', 'failed', 'disabled']);
const OVERDUE_GRACE_MS = 60 * 1000;
const MIN_RUNNING_TIMEOUT_MS = 5 * 60 * 1000;

function validServerId(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('Valid server ID is required');
  return parsed;
}

function validPipeline(value) {
  if (!PIPELINE_VALUES.has(value)) throw new Error('Unsupported pipeline status');
  return value;
}

function validInterval(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('Valid pipeline interval is required');
  return parsed;
}

function validDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date;
}

function safeErrorCode(value) {
  if (value == null || value === '') return null;
  const code = String(value);
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) throw new Error('Invalid pipeline error code');
  return code;
}

function normalizeCounters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, count]) => {
    const numeric = Number(count);
    return /^[a-z][a-zA-Z0-9]{0,39}$/.test(key) && Number.isFinite(numeric) && numeric >= 0
      ? [[key, numeric]]
      : [];
  }));
}

function buildFullSyncPipelineOutcome({
  platformServerId,
  failedServerIds = [],
  parsedServerIds = [],
  forcedErrorCode = null,
}) {
  const target = String(platformServerId);
  const failed = Boolean(forcedErrorCode || new Set([...failedServerIds].map(String)).has(target));
  return {
    status: failed ? 'degraded' : 'healthy',
    errorCode: forcedErrorCode || (failed ? 'SYNC_RUN_INCOMPLETE' : null),
    counters: {
      parsedServers: new Set([...parsedServerIds].map(String)).has(target) ? 1 : 0,
    },
  };
}

async function beginPipelineRun(db, {
  serverId,
  pipeline,
  intervalSeconds,
  enabled = true,
  now = new Date(),
}) {
  const id = validServerId(serverId);
  const kind = validPipeline(pipeline);
  const interval = validInterval(intervalSeconds);
  const startedAt = validDate(now, 'Pipeline start');
  const runId = randomUUID();
  const nextRunAt = new Date(startedAt.getTime() + interval * 1000);
  await db.run(
    `INSERT INTO server_pipeline_status (
       server_id, pipeline, run_id, enabled, state, interval_seconds,
       last_attempt_at, next_run_at, error_code, updated_at
     ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, NULL, clock_timestamp())
     ON CONFLICT (server_id, pipeline) DO UPDATE SET
       run_id = EXCLUDED.run_id,
       enabled = EXCLUDED.enabled,
       state = 'running',
       interval_seconds = EXCLUDED.interval_seconds,
       last_attempt_at = EXCLUDED.last_attempt_at,
       next_run_at = EXCLUDED.next_run_at,
       error_code = NULL,
       updated_at = clock_timestamp()`,
    [id, kind, runId, Boolean(enabled), interval, startedAt.toISOString(), nextRunAt.toISOString()]
  );
  return { serverId: id, pipeline: kind, runId, intervalSeconds: interval, startedAt };
}

async function finishPipelineRun(db, run, {
  status,
  errorCode = null,
  counters = {},
  enabled = true,
  now = new Date(),
}) {
  if (!run || typeof run !== 'object') throw new Error('Pipeline run is required');
  const id = validServerId(run.serverId);
  const kind = validPipeline(run.pipeline);
  const interval = validInterval(run.intervalSeconds);
  const runId = String(run.runId || '');
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error('Valid pipeline run ID is required');
  if (!TERMINAL_STATES.has(status)) throw new Error('Invalid terminal pipeline state');
  const completedAt = validDate(now, 'Pipeline completion');
  const startedAt = validDate(run.startedAt, 'Pipeline start');
  const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
  const nextRunAt = new Date(completedAt.getTime() + interval * 1000);
  const code = safeErrorCode(errorCode);
  const safeCounters = normalizeCounters(counters);
  await db.run(
    `UPDATE server_pipeline_status
        SET enabled = ?, state = ?, interval_seconds = ?, completed_at = ?, duration_ms = ?,
            next_run_at = ?, error_code = ?, counters = ?::jsonb,
            last_success_at = CASE WHEN ? = 'healthy' THEN ? ELSE last_success_at END,
            last_failure_at = CASE WHEN ? = 'failed' THEN ? ELSE last_failure_at END,
            updated_at = clock_timestamp()
      WHERE server_id = ? AND pipeline = ? AND run_id = ?`,
    [
      Boolean(enabled), status, interval, completedAt.toISOString(), durationMs,
      nextRunAt.toISOString(), code, JSON.stringify(safeCounters),
      status, completedAt.toISOString(), status, completedAt.toISOString(), id, kind, runId,
    ]
  );
  return { ...run, status, completedAt, durationMs, nextRunAt };
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function serializePipelineStatus(row, now = Date.now()) {
  if (!row) return null;
  const nextRunAt = iso(row.next_run_at);
  const lastAttemptAt = iso(row.last_attempt_at);
  const storedState = String(row.state || 'unknown');
  const intervalMs = Math.max(0, Number(row.interval_seconds) || 0) * 1000;
  const runningDeadlineMs = lastAttemptAt
    ? Date.parse(lastAttemptAt) + Math.max(MIN_RUNNING_TIMEOUT_MS, intervalMs * 2)
    : NaN;
  const staleRun = Boolean(
    row.enabled && storedState === 'running'
    && Number.isFinite(runningDeadlineMs) && Number(now) > runningDeadlineMs
  );
  const overdue = Boolean(
    row.enabled && (staleRun || (
      storedState !== 'running' && nextRunAt
      && Number(now) > Date.parse(nextRunAt) + OVERDUE_GRACE_MS
    ))
  );
  const state = staleRun ? 'degraded' : storedState;
  return {
    pipeline: row.pipeline,
    enabled: Boolean(row.enabled),
    state,
    intervalSeconds: row.interval_seconds == null ? null : Number(row.interval_seconds),
    running: storedState === 'running' && !staleRun,
    lastAttemptAt: iso(row.last_attempt_at),
    lastSuccessAt: iso(row.last_success_at),
    lastFailureAt: iso(row.last_failure_at),
    completedAt: iso(row.completed_at),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    nextRunAt,
    overdue,
    errorCode: staleRun ? 'RUN_OVERDUE' : safeErrorCode(row.error_code),
    counters: normalizeCounters(typeof row.counters === 'string' ? JSON.parse(row.counters) : row.counters),
  };
}

async function loadPipelineStatuses(db, serverId, now = Date.now()) {
  const rows = await db.query(
    `SELECT pipeline, enabled, state, interval_seconds, last_attempt_at,
            last_success_at, last_failure_at, completed_at, duration_ms,
            next_run_at, error_code, counters, updated_at
       FROM server_pipeline_status
      WHERE server_id = ?
      ORDER BY pipeline`,
    [validServerId(serverId)]
  );
  return Object.fromEntries(rows.map(row => [row.pipeline, serializePipelineStatus(row, now)]));
}

async function safelyRecord(logger, operation) {
  try {
    return await operation();
  } catch (error) {
    logger?.error?.('Pipeline status update failed:', error.message);
    return null;
  }
}

module.exports = {
  PIPELINES,
  beginPipelineRun,
  buildFullSyncPipelineOutcome,
  finishPipelineRun,
  loadPipelineStatuses,
  normalizeCounters,
  safelyRecord,
  serializePipelineStatus,
};
