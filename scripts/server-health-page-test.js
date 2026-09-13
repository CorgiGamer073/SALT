'use strict';

if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
}

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  PIPELINES,
  beginPipelineRun,
  buildFullSyncPipelineOutcome,
  finishPipelineRun,
  serializePipelineStatus,
} = require('../services/pipelineStatusService');
const {
  applyFeedQueueHealth,
  buildFullLogSyncStatus,
  providerTimestampIso,
  summarizeCeLoop,
} = require('../services/serverMetricsService');
const { processFeedEvents, processServerFeedEvents } = require('../workers/feedProcessor');
const { getGuildTokenForExactServer } = require('../utils/guildTokens');
const { pipelineWorkload, readJsonForContext } = require('../public/js/serverStatsState');

async function testPipelineLifecycle() {
  const calls = [];
  const db = {
    async run(sql, params) {
      calls.push({ sql, params });
      return { changes: 1 };
    },
  };
  const startedAt = new Date('2026-09-07T18:00:00.000Z');
  const completedAt = new Date('2026-09-07T18:00:01.250Z');

  const run = await beginPipelineRun(db, {
    serverId: 41,
    pipeline: PIPELINES.LOW_LATENCY_ADM,
    intervalSeconds: 30,
    now: startedAt,
  });
  await finishPipelineRun(db, run, {
    status: 'healthy',
    counters: { kills: 2 },
    now: completedAt,
  });

  assert.strictEqual(calls.length, 2);
  assert.match(calls[0].sql, /INSERT INTO server_pipeline_status/);
  assert.match(calls[0].sql, /last_attempt_at/);
  assert.strictEqual(calls[0].params[0], 41);
  assert.strictEqual(calls[0].params[1], 'low_latency_adm');
  assert.match(calls[0].params[2], /^[0-9a-f-]{36}$/);
  assert.deepStrictEqual(calls[0].params.slice(3, 5), [true, 30]);
  assert.match(calls[1].sql, /last_success_at/);
  assert.match(calls[1].sql, /duration_ms/);
  assert.match(calls[1].sql, /run_id = \?/);
  assert(calls[1].params.includes(1250));
  assert(calls[1].params.includes(calls[0].params[2]));
}

async function testStalePipelineCompletionCannotOverwriteNewRun() {
  let currentRunId = null;
  let state = null;
  const db = {
    async run(sql, params) {
      if (sql.includes('INSERT INTO server_pipeline_status')) {
        currentRunId = params[2];
        state = 'running';
        return { changes: 1 };
      }
      if (sql.includes('UPDATE server_pipeline_status') && params.at(-1) === currentRunId) {
        state = params[1];
        return { changes: 1 };
      }
      return { changes: 0 };
    },
  };
  const first = await beginPipelineRun(db, {
    serverId: 41,
    pipeline: PIPELINES.FEED_PROCESSOR,
    intervalSeconds: 30,
    now: new Date('2026-09-07T18:00:00.000Z'),
  });
  const second = await beginPipelineRun(db, {
    serverId: 41,
    pipeline: PIPELINES.FEED_PROCESSOR,
    intervalSeconds: 30,
    now: new Date('2026-09-07T18:00:01.000Z'),
  });
  await finishPipelineRun(db, first, {
    status: 'healthy',
    now: new Date('2026-09-07T18:00:02.000Z'),
  });
  assert.strictEqual(state, 'running');
  await finishPipelineRun(db, second, {
    status: 'healthy',
    now: new Date('2026-09-07T18:00:03.000Z'),
  });
  assert.strictEqual(state, 'healthy');
}

function testSafeSerialization() {
  const result = serializePipelineStatus({
    pipeline: 'feed_processor',
    enabled: true,
    state: 'failed',
    interval_seconds: 30,
    last_attempt_at: '2026-09-07T18:00:00.000Z',
    last_success_at: '2026-09-07T17:59:30.000Z',
    last_failure_at: '2026-09-07T18:00:00.500Z',
    completed_at: '2026-09-07T18:00:00.500Z',
    duration_ms: 500,
    next_run_at: '2026-09-07T18:00:30.500Z',
    error_code: 'FEED_DELIVERY_FAILED',
    counters: { pending: '3', retrying: 1 },
    updated_at: '2026-09-07T18:00:00.500Z',
  }, Date.parse('2026-09-07T18:00:01.000Z'));

  assert.deepStrictEqual(result, {
    pipeline: 'feed_processor',
    enabled: true,
    state: 'failed',
    intervalSeconds: 30,
    running: false,
    lastAttemptAt: '2026-09-07T18:00:00.000Z',
    lastSuccessAt: '2026-09-07T17:59:30.000Z',
    lastFailureAt: '2026-09-07T18:00:00.500Z',
    completedAt: '2026-09-07T18:00:00.500Z',
    durationMs: 500,
    nextRunAt: '2026-09-07T18:00:30.500Z',
    overdue: false,
    errorCode: 'FEED_DELIVERY_FAILED',
    counters: { pending: 3, retrying: 1 },
  });
}

function testPipelineOverdueUsesMissedRunGrace() {
  const running = {
    pipeline: 'feed_processor',
    enabled: true,
    state: 'running',
    interval_seconds: 30,
    last_attempt_at: '2026-09-07T18:00:00.000Z',
    next_run_at: '2026-09-07T18:00:30.000Z',
    counters: {},
  };
  const active = serializePipelineStatus(running, Date.parse('2026-09-07T18:04:59.000Z'));
  assert.strictEqual(active.state, 'running');
  assert.strictEqual(active.running, true);
  assert.strictEqual(active.overdue, false);

  const stale = serializePipelineStatus(running, Date.parse('2026-09-07T18:05:01.000Z'));
  assert.strictEqual(stale.state, 'degraded');
  assert.strictEqual(stale.running, false);
  assert.strictEqual(stale.overdue, true);
  assert.strictEqual(stale.errorCode, 'RUN_OVERDUE');

  const healthy = serializePipelineStatus({
    ...running,
    state: 'healthy',
    completed_at: '2026-09-07T18:00:00.000Z',
  }, Date.parse('2026-09-07T18:01:20.000Z'));
  assert.strictEqual(healthy.state, 'healthy');
  assert.strictEqual(healthy.overdue, false);
  const missed = serializePipelineStatus({
    ...running,
    state: 'healthy',
    completed_at: '2026-09-07T18:00:00.000Z',
  }, Date.parse('2026-09-07T18:01:31.000Z'));
  assert.strictEqual(missed.overdue, true);
}

function testFullSyncOutcomesRemainExactServerScoped() {
  const failed = buildFullSyncPipelineOutcome({
    platformServerId: 'server-a',
    failedServerIds: ['server-a'],
    parsedServerIds: ['server-b'],
  });
  const healthy = buildFullSyncPipelineOutcome({
    platformServerId: 'server-b',
    failedServerIds: ['server-a'],
    parsedServerIds: ['server-b'],
  });
  assert.deepStrictEqual(failed, {
    status: 'degraded',
    errorCode: 'SYNC_RUN_INCOMPLETE',
    counters: { parsedServers: 0 },
  });
  assert.deepStrictEqual(healthy, {
    status: 'healthy',
    errorCode: null,
    counters: { parsedServers: 1 },
  });
  assert.strictEqual(Object.hasOwn(healthy.counters, 'downloaded'), false);
}

function testFullSyncProjection() {
  const now = Date.parse('2026-09-07T18:00:00.000Z');
  const status = buildFullLogSyncStatus([
    {
      auto_log_sync: JSON.stringify({
        enabled: true,
        interval: 15,
        servers: ['19811740'],
        autoScan: true,
        lastAttempt: '2026-09-07T17:50:00.000Z',
        lastRun: '2026-09-07T17:45:00.000Z',
      }),
    },
    {
      auto_log_sync: JSON.stringify({
        enabled: true,
        interval: 30,
        servers: ['other-server'],
        autoScan: true,
      }),
    },
  ], '19811740', null, {
    last_sync_at: '2026-09-07T17:45:10.000Z',
    log_parse_watermark_at: '2026-09-07T17:44:59.000Z',
  }, now);

  assert.strictEqual(status.enabled, true);
  assert.strictEqual(status.intervalSeconds, 900);
  assert.strictEqual(status.state, 'degraded');
  assert.strictEqual(status.lastAttemptAt, '2026-09-07T17:50:00.000Z');
  assert.strictEqual(status.lastSuccessAt, '2026-09-07T17:45:00.000Z');
  assert.strictEqual(status.lastParseSuccessAt, '2026-09-07T17:45:10.000Z');
  assert.strictEqual(status.sourceObservedThrough, '2026-09-07T17:44:59.000Z');
  assert.strictEqual(status.nextRunAt, '2026-09-07T18:05:00.000Z');
}

function testFullSyncScheduleAllowsPollingGrace() {
  const rows = [{ auto_log_sync: JSON.stringify({
    enabled: true,
    autoScan: true,
    interval: 0.5,
    servers: ['19811740'],
    lastAttempt: '2026-09-07T18:00:00.000Z',
    lastRun: '2026-09-07T18:00:00.000Z',
  }) }];
  const runtime = {
    pipeline: PIPELINES.FULL_LOG_SYNC,
    enabled: true,
    state: 'healthy',
    intervalSeconds: 30,
    running: false,
    lastAttemptAt: '2026-09-07T18:00:00.000Z',
    lastSuccessAt: '2026-09-07T18:00:00.000Z',
    nextRunAt: '2026-09-07T18:00:30.000Z',
    overdue: false,
    counters: {},
  };
  const withinGrace = buildFullLogSyncStatus(
    rows, '19811740', runtime, {}, Date.parse('2026-09-07T18:01:20.000Z')
  );
  assert.strictEqual(withinGrace.overdue, false);
  const missed = buildFullLogSyncStatus(
    rows, '19811740', runtime, {}, Date.parse('2026-09-07T18:01:31.000Z')
  );
  assert.strictEqual(missed.overdue, true);
}

function testCeTelemetryAbsenceIsInformational() {
  const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'serverMetricsService.js'), 'utf8');
  assert.doesNotMatch(serviceSource, /warnings\.push\('RPT_TELEMETRY_EMPTY'\)/);
}

function testCeLoopSummary() {
  assert.deepStrictEqual(summarizeCeLoop({
    sample_count: '12',
    latest_at: '2026-09-07T17:59:00.000Z',
    latest_duration_seconds: '1.25',
    average_duration_seconds: '1.5',
    p95_duration_seconds: '2.75',
    max_duration_seconds: '3.5',
    latest_players: '11',
    latest_loot: '23500',
    latest_infected: '330',
    latest_animals: '185',
  }), {
    sampleCount: 12,
    latestAt: '2026-09-07T17:59:00.000Z',
    latestDurationSeconds: 1.25,
    averageDurationSeconds: 1.5,
    p95DurationSeconds: 2.75,
    maxDurationSeconds: 3.5,
    latestCounts: { players: 11, loot: 23500, infected: 330, animals: 185 },
  });
}

function testCrossLayerContracts() {
  const root = path.join(__dirname, '..');
  const route = fs.readFileSync(path.join(root, 'routes', 'serverStats.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public', 'dashboard', 'server-stats.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'public', 'js', 'serverStats.js'), 'utf8');
  const registration = fs.readFileSync(path.join(root, 'src', 'app', 'registerRoutes.js'), 'utf8');

  assert.match(route, /requireServerCapability\(CAPABILITIES\.SERVER_MODERATE\)/);
  assert.match(route, /router\.get\('\/:serverId\/overview'/);
  assert.match(route, /loadServerOverview/);
  assert.match(registration, /server-stats'[\s\S]*ensureHasModeratableServers/);
  for (const id of [
    'overallStatus', 'lastRefresh', 'nextRefresh', 'refreshButton',
    'currentServerState', 'pipelineLowLatency', 'pipelineFullSync',
    'pipelineFeed', 'serviceHealth', 'ceLoopSummary',
  ]) {
    assert(html.includes(`id="${id}"`), `server health page is missing #${id}`);
  }
  assert.match(html, /name="viewport"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(client, /AbortController/);
  assert.match(client, /document\.visibilityState/);
  assert.match(client, /nextRefreshAt/);
  assert.match(client, /setInterval\([^]*1000\)/);
  assert.match(client, /\/api\/stats\/\$\{[^}]+\}\/overview/);
}

function testWorkerInstrumentationContracts() {
  const root = path.join(__dirname, '..');
  const migration = fs.readFileSync(path.join(root, 'db', 'migrations', '089_server_pipeline_status.js'), 'utf8');
  const lowLatency = fs.readFileSync(path.join(root, 'services', 'lowLatencyAdmIngestionService.js'), 'utf8');
  const feed = fs.readFileSync(path.join(root, 'workers', 'feedProcessor.js'), 'utf8');
  const scheduler = fs.readFileSync(path.join(root, 'scheduler.js'), 'utf8');

  assert.match(migration, /CREATE TABLE IF NOT EXISTS server_pipeline_status/);
  assert.match(migration, /PRIMARY KEY \(server_id, pipeline\)/);
  assert.match(lowLatency, /PIPELINES\.LOW_LATENCY_ADM/);
  assert.match(lowLatency, /beginPipelineRun/);
  assert.match(lowLatency, /finishPipelineRun/);
  assert.match(feed, /PIPELINES\.FEED_PROCESSOR/);
  assert.match(feed, /feedTickRunning/);
  assert.match(feed, /beginPipelineRun/);
  assert.match(feed, /finishPipelineRun/);
  assert.match(scheduler, /PIPELINES\.FULL_LOG_SYNC/);
  assert.match(scheduler, /beginPipelineRun/);
  assert.match(scheduler, /finishPipelineRun/);
}

async function testFeedProcessorRecordsExactServerTick() {
  const completions = [];
  const db = {
    async query() {
      return [{ guild_id: 'guild-1', server_id: 41 }];
    },
  };
  const result = await processFeedEvents(db, {
    intervalSeconds: 30,
    beginStatus: async (_db, input) => ({
      serverId: input.serverId,
      pipeline: input.pipeline,
      intervalSeconds: input.intervalSeconds,
      startedAt: new Date('2026-09-07T18:00:00.000Z'),
    }),
    finishStatus: async (_db, _run, input) => completions.push(input),
    processServerFeeds: async () => ({ status: 'succeeded', events: 2 }),
    cleanupEvents: async () => {},
    logger: { log() {}, error() {} },
  });

  assert.deepStrictEqual(result, { status: 'succeeded', queues: 1, failed: 0 });
  assert.strictEqual(completions.length, 1);
  assert.strictEqual(completions[0].status, 'healthy');
  assert.deepStrictEqual(completions[0].counters, { claimed: 2, failed: 0 });
}

async function testFeedProcessorRecordsFailedQueueAndContinues() {
  const completions = [];
  let queueCalls = 0;
  const db = {
    async query() {
      return [
        { guild_id: 'guild-1', server_id: 41 },
        { guild_id: 'guild-1', server_id: 42 },
      ];
    },
  };
  const result = await processFeedEvents(db, {
    intervalSeconds: 30,
    beginStatus: async (_db, input) => ({
      serverId: input.serverId,
      pipeline: input.pipeline,
      intervalSeconds: input.intervalSeconds,
      startedAt: new Date('2026-09-07T18:00:00.000Z'),
    }),
    finishStatus: async (_db, run, input) => completions.push({ serverId: run.serverId, ...input }),
    processServerFeeds: async () => {
      queueCalls += 1;
      if (queueCalls === 1) throw new Error('provider detail must remain in logs only');
      return { status: 'succeeded', events: 0 };
    },
    cleanupEvents: async () => {},
    logger: { log() {}, error() {} },
  });

  assert.deepStrictEqual(result, { status: 'degraded', queues: 2, failed: 1 });
  assert.deepStrictEqual(completions.map(item => [item.serverId, item.status, item.errorCode]), [
    [41, 'failed', 'FEED_PROCESSING_FAILED'],
    [42, 'healthy', null],
  ]);
  assert(!JSON.stringify(completions).includes('provider detail'));
}

async function testFeedDeliveryFailurePropagatesToPipelineOutcome() {
  const db = {
    async get(sql) {
      if (sql.includes("feed_type = 'kill_feed'")) return { settings: '{}' };
      if (sql.includes("feed_type = 'faction_feed'")) return null;
      return { count: 0 };
    },
    async query() {
      return [{ id: 1, feed_type: 'kill_feed' }];
    },
    async run() {},
  };
  const result = await processServerFeedEvents(db, 'guild-1', 41, {
    processOne: async () => 'failed',
  });
  assert.deepStrictEqual(result, { status: 'failed', events: 1, failed: 1 });
}

async function testTokenLookupUsesAuthorizedCanonicalServer() {
  const calls = [];
  const token = await getGuildTokenForExactServer({
    async get(sql, params) {
      calls.push({ sql, params });
      return null;
    },
  }, 41, 9);
  assert.strictEqual(token, null);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].sql, /s\.id = \?/);
  assert.match(calls[0].sql, /s\.guild_id = \?/);
  assert.deepStrictEqual(calls[0].params, [41, 9]);
}

function testAutomationProjectionIsExactServerAuthorized() {
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'serverMetricsService.js'),
    'utf8'
  );
  assert.match(service, /FROM automation_settings a[\s\S]*server_role_assignments/);
  assert.match(service, /sra\.server_id = \?/);
}

async function testStaleDecodedResponseIsDiscarded() {
  let resolveBody;
  let generation = 1;
  const response = {
    ok: true,
    status: 200,
    json: () => new Promise(resolve => { resolveBody = resolve; }),
  };
  const pending = readJsonForContext(response, () => generation === 1);
  generation = 2;
  resolveBody({ success: true, server: { id: 41 } });
  const result = await pending;
  assert.deepStrictEqual(result, { stale: true, body: null });
}

function testProviderSecondTimestampIsNormalized() {
  assert.strictEqual(
    providerTimestampIso(1788811200),
    '2026-09-07T20:00:00.000Z'
  );
}

function testFeedQueueEvidenceOverridesNonFailedPipelineStates() {
  const retryQueue = { pending: 0, retrying: 1, failed: 0 };
  const failedQueue = { pending: 0, retrying: 0, failed: 1 };
  for (const state of ['healthy', 'running', 'unknown']) {
    const projected = applyFeedQueueHealth({ state, errorCode: null }, retryQueue, true);
    assert.strictEqual(projected.state, 'degraded');
    assert.strictEqual(projected.errorCode, 'FEED_DELIVERY_RETRYING');
  }
  const missing = applyFeedQueueHealth({ state: 'unknown', errorCode: null }, failedQueue, true);
  assert.strictEqual(missing.state, 'degraded');
  assert.strictEqual(missing.errorCode, 'FEED_DELIVERY_FAILED');
  const alreadyFailed = applyFeedQueueHealth(
    { state: 'failed', errorCode: 'FEED_PROCESSING_FAILED' },
    failedQueue,
    true
  );
  assert.strictEqual(alreadyFailed.state, 'failed');
  assert.strictEqual(alreadyFailed.errorCode, 'FEED_PROCESSING_FAILED');
}

function testPipelineWorkloadLabelsMatchPipelineMeaning() {
  assert.strictEqual(
    pipelineWorkload('pipelineLowLatency', { kills: 3 }),
    '3 new kills'
  );
  assert.strictEqual(
    pipelineWorkload('pipelineFullSync', { parsedServers: 1 }),
    '1 parsed this run'
  );
  assert.strictEqual(
    pipelineWorkload('pipelineFeed', { pending: 2, retrying: 1, failed: 0 }),
    '2 pending · 1 retrying · 0 failed'
  );
}

async function main() {
  assert.deepStrictEqual(Object.values(PIPELINES).sort(), [
    'feed_processor',
    'full_log_sync',
    'low_latency_adm',
  ]);
  await testPipelineLifecycle();
  await testStalePipelineCompletionCannotOverwriteNewRun();
  testSafeSerialization();
  testPipelineOverdueUsesMissedRunGrace();
  testFullSyncOutcomesRemainExactServerScoped();
  testFullSyncProjection();
  testFullSyncScheduleAllowsPollingGrace();
  testCeTelemetryAbsenceIsInformational();
  testCeLoopSummary();
  testCrossLayerContracts();
  testWorkerInstrumentationContracts();
  await testFeedProcessorRecordsExactServerTick();
  await testFeedProcessorRecordsFailedQueueAndContinues();
  await testFeedDeliveryFailurePropagatesToPipelineOutcome();
  await testTokenLookupUsesAuthorizedCanonicalServer();
  testAutomationProjectionIsExactServerAuthorized();
  await testStaleDecodedResponseIsDiscarded();
  testProviderSecondTimestampIsNormalized();
  testFeedQueueEvidenceOverridesNonFailedPipelineStates();
  testPipelineWorkloadLabelsMatchPipelineMeaning();
  console.log('Server health page tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
