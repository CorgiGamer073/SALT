'use strict';

const { createRptChronology, parseRptClockTimestamp } = require('../utils/rptChronology');

const EVENT_TYPE_CE_LOOP = 'dayz.ce.loop';
const RPT_TELEMETRY_EVENT_TYPES = Object.freeze([EVENT_TYPE_CE_LOOP]);
const EVENT_SCHEMA_VERSION = 1;
const TIMESTAMP_PATTERN = /^\s*(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)/;
const CE_LOOP_PATTERN = /\*{3}\s*CE Loop took\s+([\d.]+)\s*\(sec\)/i;
const CE_COUNTS_PATTERN = /players:\s*(\d+),\s*loot:\s*(\d+),\s*infected:\s*(\d+),\s*animals:\s*(\d+)/i;

function normalizeSourceFile(sourceFile) {
  const normalized = String(sourceFile || '').replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')
      || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('RPT telemetry sourceFile must be a safe relative path');
  }
  return normalized;
}

function createRptTelemetryCollector({ logDate, sourceFile } = {}) {
  const safeSourceFile = normalizeSourceFile(sourceFile);

  const chronology = createRptChronology();
  const events = [];
  let pendingLoop = null;

  return {
    events,
    consume(line, sourceLine) {
      const clock = line.match(TIMESTAMP_PATTERN)?.[1] || null;
      const timestampMs = clock ? parseRptClockTimestamp(clock, logDate, chronology) : null;
      const counts = line.match(CE_COUNTS_PATTERN);

      if (pendingLoop) {
        if (sourceLine === pendingLoop.sourceLine + 1 && counts) {
          events.push({
            eventType: EVENT_TYPE_CE_LOOP,
            timestamp: new Date(pendingLoop.timestampMs).toISOString(),
            sourceFile: safeSourceFile,
            sourceLine: pendingLoop.sourceLine,
            schemaVersion: EVENT_SCHEMA_VERSION,
            payload: {
              durationSeconds: pendingLoop.durationSeconds,
              players: Number(counts[1]),
              loot: Number(counts[2]),
              infected: Number(counts[3]),
              animals: Number(counts[4]),
            },
          });
        }
        pendingLoop = null;
      }

      const loop = line.match(CE_LOOP_PATTERN);
      if (!loop || timestampMs === null) return;
      const durationSeconds = Number(loop[1]);
      if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return;
      pendingLoop = { durationSeconds, timestampMs, sourceLine };
    },
  };
}

function parseRptTelemetryLines(content, options = {}) {
  const lines = Array.isArray(content) ? content : String(content || '').split(/\r?\n/);
  const collector = createRptTelemetryCollector(options);
  for (let index = 0; index < lines.length; index += 1) {
    collector.consume(lines[index], index + 1);
  }
  return collector.events;
}

async function replaceRptTelemetryEvents(db, serverId, sourceFile, events) {
  // Reconcile only a source that was successfully read. If an archived file later
  // disappears from local storage, its historical observations remain available.
  const exactServerId = Number(serverId);
  const safeSourceFile = normalizeSourceFile(sourceFile);
  if (!Number.isSafeInteger(exactServerId) || exactServerId <= 0) {
    throw new Error('RPT telemetry persistence requires a positive exact server ID');
  }
  if (!Array.isArray(events)) throw new Error('RPT telemetry events must be an array');
  if (!db || typeof db.transaction !== 'function') {
    throw new Error('RPT telemetry persistence requires transactional database access');
  }

  for (const event of events) {
    if (!RPT_TELEMETRY_EVENT_TYPES.includes(event.eventType)
        || normalizeSourceFile(event.sourceFile) !== safeSourceFile
        || !Number.isSafeInteger(Number(event.sourceLine)) || Number(event.sourceLine) <= 0
        || !Number.isSafeInteger(Number(event.schemaVersion)) || Number(event.schemaVersion) <= 0
        || !Number.isFinite(new Date(event.timestamp).getTime())) {
      throw new Error('Invalid RPT telemetry event');
    }
  }

  return db.transaction(async tx => {
    let written = 0;
    const batchSize = 500;
    for (let index = 0; index < events.length; index += batchSize) {
      const batch = events.slice(index, index + batchSize);
      const values = [];
      const placeholders = batch.map(event => {
        values.push(
          exactServerId,
          event.eventType,
          new Date(event.timestamp),
          safeSourceFile,
          Number(event.sourceLine),
          Number(event.schemaVersion),
          JSON.stringify(event.payload ?? {})
        );
        return '(?, ?, ?, ?, ?, ?, ?::jsonb)';
      });
      const rows = await tx.query(`
        INSERT INTO rpt_telemetry_events (
          server_id, event_type, observed_at, source_file,
          source_line, schema_version, payload
        ) VALUES ${placeholders.join(', ')}
        ON CONFLICT (server_id, event_type, source_file, source_line) DO UPDATE SET
          observed_at = EXCLUDED.observed_at,
          schema_version = EXCLUDED.schema_version,
          payload = EXCLUDED.payload,
          updated_at = clock_timestamp(),
          deleted_at = NULL
        WHERE rpt_telemetry_events.observed_at IS DISTINCT FROM EXCLUDED.observed_at
           OR rpt_telemetry_events.schema_version IS DISTINCT FROM EXCLUDED.schema_version
           OR rpt_telemetry_events.payload IS DISTINCT FROM EXCLUDED.payload
           OR rpt_telemetry_events.deleted_at IS NOT NULL
        RETURNING id
      `, values);
      written += rows.length;
    }

    let retired = 0;
    for (const eventType of RPT_TELEMETRY_EVENT_TYPES) {
      const currentLines = events
        .filter(event => event.eventType === eventType)
        .map(event => Number(event.sourceLine));
      const result = await tx.run(
        `UPDATE rpt_telemetry_events
         SET deleted_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE server_id = ? AND source_file = ? AND event_type = ?
           AND deleted_at IS NULL
           AND NOT (source_line = ANY(?::bigint[]))`,
        [exactServerId, safeSourceFile, eventType, currentLines]
      );
      retired += result.changes ?? 0;
    }

    return { written, retired };
  });
}

module.exports = {
  EVENT_TYPE_CE_LOOP,
  RPT_TELEMETRY_EVENT_TYPES,
  EVENT_SCHEMA_VERSION,
  createRptTelemetryCollector,
  parseRptTelemetryLines,
  replaceRptTelemetryEvents,
};
