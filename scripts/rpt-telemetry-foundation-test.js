'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);
const {
  parseRptTelemetryLines,
  replaceRptTelemetryEvents,
} = require('../services/rptTelemetryService');
const {
  extractRPTTelemetryLogDate,
  parseRPTFileObservations,
} = require('../routes/logParser');

async function testCeLoopParsing() {
  const events = parseRptTelemetryLines([
    '17:38:28.325 ------------------------------------',
    '17:38:28.325   ***  CE Loop took 26.9 (sec)...',
    '17:38:28.325 players: 11, loot: 23500, infected: 330, animals: 185',
    '17:38:28.325 ------------------------------------',
  ], {
    logDate: '2026-09-07',
    sourceFile: 'DayZServerP_X1_x64_2026-09-07_12-26-07.RPT',
  });

  assert.deepStrictEqual(events, [{
    eventType: 'dayz.ce.loop',
    timestamp: '2026-09-07T17:38:28.325Z',
    sourceFile: 'DayZServerP_X1_x64_2026-09-07_12-26-07.RPT',
    sourceLine: 2,
    schemaVersion: 1,
    payload: {
      durationSeconds: 26.9,
      players: 11,
      loot: 23500,
      infected: 330,
      animals: 185,
    },
  }]);
}

async function testIncompleteAndMidnightTelemetry() {
  const events = parseRptTelemetryLines([
    '23:59:59.900   ***  CE Loop took 1.2 (sec)...',
    '00:00:00.100 unrelated line advances chronology',
    '00:00:01.100 players: 1, loot: 2, infected: 3, animals: 4',
    '00:00:02.100   ***  CE Loop took 2.5 (sec)...',
    '00:00:02.100 players: 5, loot: 6, infected: 7, animals: 8',
  ], {
    logDate: '2026-09-07',
    sourceFile: 'midnight.RPT',
  });

  assert.strictEqual(events.length, 1, 'an unrelated line must break an incomplete CE-loop pair');
  assert.strictEqual(events[0].timestamp, '2026-09-08T00:00:02.100Z');
  assert.strictEqual(events[0].sourceLine, 4);
  assert.deepStrictEqual(parseRptTelemetryLines([
    '00:00:02.100   ***  CE Loop took 2.5 (sec)...',
    '00:00:02.100 players: 5, loot: 6, infected: 7, animals: 8',
  ], { logDate: '2026-02-29', sourceFile: 'invalid-date.RPT' }), [],
  'impossible filename dates must not normalize into persisted telemetry');
}

async function testSinglePassFileObservations() {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rpt-telemetry-'));
  const nestedA = path.join(dir, 'a');
  const nestedB = path.join(dir, 'b');
  fs.mkdirSync(nestedA);
  fs.mkdirSync(nestedB);
  const fileName = 'DayZServerP_X1_x64_2026-09-07_12-26-07.RPT';
  const file = path.join(nestedA, fileName);
  const otherFile = path.join(nestedB, fileName);
  try {
    const content = [
      '17:38:27.000 [MAM] :: [NetworkServer::CheckMAMData] :: device: DEVICE123 | account: AABBCCDDEEFF0011',
      '17:38:28.000 Player FixtureOne (id=AABBCCDDEEFF0011) has connected.',
      '17:38:28.325   ***  CE Loop took 26.9 (sec)...',
      '17:38:28.325 players: 11, loot: 23500, infected: 330, animals: 185',
      '17:38:29.000 <cleanup> Depleted:"Wrench" at [12618,13820] damage=0.52',
      '17:39:00.000 [Login]: Adding player Fixture One (12345678) to login queue at position 0',
      '17:39:01.000 [StateMachine]: Player Fixture One (dpnid 12345678 uid AABBCCDDEEFF0011) Entering DBWaitLoginTimeLoginState',
      '17:40:11.000 [StateMachine]: Player Fixture One (dpnid 12345678 uid AABBCCDDEEFF0011) Entering DBGetCharacterLoginState',
    ].join('\n');
    fs.writeFileSync(file, content);
    fs.writeFileSync(otherFile, content);
    const observations = await parseRPTFileObservations(file, '2026-09-07', 'xbox', { rootDir: dir });
    const other = await parseRPTFileObservations(otherFile, '2026-09-07', 'xbox', { rootDir: dir });
    assert.strictEqual(observations.loginWaits.length, 1);
    assert.strictEqual(observations.telemetryEvents.length, 1);
    assert.strictEqual(observations.players.length, 1);
    assert.strictEqual(observations.cleanups.length, 1);
    assert.strictEqual(observations.players[0].deviceId, 'DEVICE123');
    assert.strictEqual(observations.cleanups[0].damage, 0.52);
    assert.strictEqual(observations.telemetryEvents[0].eventType, 'dayz.ce.loop');
    assert.strictEqual(observations.telemetryEvents[0].sourceLine, 3);
    assert.strictEqual(observations.telemetryEvents[0].sourceFile, `a/${fileName}`);
    assert.strictEqual(other.telemetryEvents[0].sourceFile, `b/${fileName}`,
      'recursive RPT inventory must not collapse duplicate basenames');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testTransactionalSourceReconciliation() {
  const calls = [];
  const tx = {
    async query(sql, params) {
      calls.push({ kind: 'query', sql: sql.replace(/\s+/g, ' ').trim(), params });
      return [{ id: 41 }];
    },
    async run(sql, params) {
      calls.push({ kind: 'run', sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { changes: 2 };
    },
  };
  const db = {
    async transaction(callback) {
      calls.push({ kind: 'transaction' });
      return callback(tx);
    },
  };

  const result = await replaceRptTelemetryEvents(db, 7, 'archive/fixture.RPT', [{
    eventType: 'dayz.ce.loop',
    timestamp: '2026-09-07T17:38:28.325Z',
    sourceFile: 'archive/fixture.RPT',
    sourceLine: 2,
    schemaVersion: 1,
    payload: { durationSeconds: 26.9, players: 11, loot: 23500, infected: 330, animals: 185 },
  }]);

  assert.deepStrictEqual(result, { written: 1, retired: 2 });
  assert.strictEqual(calls[0].kind, 'transaction');
  assert.match(calls[1].sql, /INSERT INTO rpt_telemetry_events/i);
  assert.match(calls[1].sql, /ON CONFLICT \(server_id, event_type, source_file, source_line\) DO UPDATE/i);
  assert.match(calls[1].sql, /payload = EXCLUDED\.payload/i,
    'same-path replacements must correct stale source-derived observations');
  assert.match(calls[2].sql, /SET deleted_at = clock_timestamp/i,
    'successful source replacement must retire observations no longer present');
  assert.deepStrictEqual(calls[2].params, [7, 'archive/fixture.RPT', 'dayz.ce.loop', [2]]);

  const emptyCalls = [];
  const emptyResult = await replaceRptTelemetryEvents({
    async transaction(callback) {
      return callback({
        async query() {
          throw new Error('empty replacement must not insert');
        },
        async run(sql, params) {
          emptyCalls.push({ sql, params });
          return { changes: 3 };
        },
      });
    },
  }, 7, 'archive/fixture.RPT', []);
  assert.deepStrictEqual(emptyResult, { written: 0, retired: 3 });
  assert.deepStrictEqual(emptyCalls[0].params[3], [],
    'an empty successful source scan must retire all managed observations for that source');

  let insertBatches = 0;
  const manyEvents = Array.from({ length: 501 }, (_, index) => ({
    eventType: 'dayz.ce.loop',
    timestamp: '2026-09-07T17:38:28.325Z',
    sourceFile: 'archive/large.RPT',
    sourceLine: index + 1,
    schemaVersion: 1,
    payload: { durationSeconds: 1 },
  }));
  const batchResult = await replaceRptTelemetryEvents({
    async transaction(callback) {
      return callback({
        async query(sql, params) {
          insertBatches += 1;
          return Array.from({ length: params.length / 7 }, (_, index) => ({ id: index + 1 }));
        },
        async run() {
          return { changes: 0 };
        },
      });
    },
  }, 7, 'archive/large.RPT', manyEvents);
  assert.strictEqual(insertBatches, 2);
  assert.strictEqual(batchResult.written, 501);
}

function testInvalidTimestampFilenameFailsClosed() {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rpt-date-'));
  const file = path.join(dir, 'DayZServerP_X1_x64_2026-02-29_12-00-00.RPT');
  try {
    fs.writeFileSync(file, 'fixture\n');
    assert.throws(() => extractRPTTelemetryLogDate(file), /supported timestamped filename/);
    assert.throws(() => extractRPTTelemetryLogDate(path.join(dir, 'arbitrary.RPT')),
      /supported timestamped filename/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testProductionScanUsesOneRptPass() {
  const source = fs.readFileSync(path.join(ROOT, 'routes/logParser.js'), 'utf8');
  const loopStart = source.indexOf('for (const logPath of allRptLogs)');
  const loopEnd = source.indexOf('if (failedLogFiles.length > 0)', loopStart);
  const loop = source.slice(loopStart, loopEnd);
  assert.ok(loopStart >= 0 && loopEnd > loopStart);
  assert.doesNotMatch(loop, /readLogFileSafely|\.split\(['"]\\n['"]\)/,
    'production RPT ingestion must not synchronously read and then stream the same file');
}

function testMigrationContract() {
  const migration = fs.readFileSync(path.join(ROOT, 'db/migrations/088_rpt_telemetry_event_sources.js'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS rpt_telemetry_events/i);
  assert.match(migration, /source_file TEXT NOT NULL/i);
  assert.match(migration, /source_line BIGINT NOT NULL/i);
  assert.match(migration, /schema_version SMALLINT NOT NULL/i);
  assert.match(migration, /UNIQUE \(server_id, event_type, source_file, source_line\)/i);
  assert.match(migration, /WHERE deleted_at IS NULL/i);
}

async function run() {
  await testCeLoopParsing();
  await testIncompleteAndMidnightTelemetry();
  await testSinglePassFileObservations();
  await testTransactionalSourceReconciliation();
  testInvalidTimestampFilenameFailsClosed();
  testProductionScanUsesOneRptPass();
  testMigrationContract();
  console.log('RPT telemetry foundation tests passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
