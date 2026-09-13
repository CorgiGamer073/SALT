'use strict';

const { decryptToken: decryptStoredToken } = require('../utils/encryption');
const { syncLatestAdmForExactServer, providerModifiedAtMs } = require('./logSyncService');
const {
  ingestExactServerAdmFiles,
  publishExactServerOnlineSnapshot,
} = require('./logScanService');
const { acquireExactServerLogLocks } = require('../utils/logIngestionLock');
const { processServerFeedEvents } = require('../workers/feedProcessor');
const { compareLogFileEntries } = require('../utils/logFileChronology');
const {
  ProviderLogStorageUnavailableError,
  providerLogAvailability,
} = require('../utils/providerLogAvailability');
const {
  PIPELINES,
  beginPipelineRun,
  finishPipelineRun,
} = require('./pipelineStatusService');

async function loadLowLatencyAdmTargets(db) {
  const rows = await db.query(
    `SELECT s.id AS server_id,
            CAST(s.platform_server_id AS TEXT) AS platform_server_id,
            g.discord_guild_id,
            MIN(gt.token_hash) AS token_hash
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id
     JOIN discord_feeds df ON df.guild_id = g.discord_guild_id
       AND df.server_id = s.id AND df.feed_type = ? AND df.enabled = 1
     JOIN guild_tokens gt ON gt.guild_id = g.id AND gt.token_type = ?
       AND gt.nitrado_user_id IS NOT NULL
     WHERE s.status = 'active' AND g.status = 'approved'
     GROUP BY s.id, s.platform_server_id, g.discord_guild_id
     HAVING COUNT(DISTINCT gt.id) = 1
     ORDER BY s.id`,
    ['kill_feed', 'nitrado']
  );
  return rows.map(row => ({
    serverId: Number(row.server_id),
    platformServerId: String(row.platform_server_id),
    guildId: String(row.discord_guild_id),
    tokenHash: row.token_hash,
  }));
}

async function loadPersistedAdmCursors(db, serverId) {
  if (typeof db?.query !== 'function') return new Map();
  const rows = await db.query(
    `SELECT remote_name, byte_offset, source_line_base, previous_line_timestamp,
            content_fingerprint
     FROM low_latency_adm_cursors
     WHERE server_id = ?`,
    [serverId]
  );
  return new Map(rows.map(row => [row.remote_name, {
    offset: Number(row.byte_offset),
    sourceLineBase: Number(row.source_line_base),
    previousLineTimestamp: row.previous_line_timestamp || null,
    fingerprint: row.content_fingerprint,
  }]));
}

async function persistAdmCursors(db, serverId, admFiles, cursors) {
  if (typeof db?.transaction !== 'function') return;
  const records = admFiles.map(file => {
    const cursor = cursors.get(file.name);
    const modifiedAtMs = providerModifiedAtMs(file.modifiedAt);
    const modifiedAt = modifiedAtMs === null ? new Date(NaN) : new Date(modifiedAtMs);
    if (!cursor
      || !file.remotePath
      || !Number.isSafeInteger(Number(cursor.offset))
      || Number(cursor.offset) < 0
      || Number(cursor.offset) > Number(file.size)
      || !Number.isSafeInteger(Number(cursor.sourceLineBase))
      || Number(cursor.sourceLineBase) < 0
      || !/^[a-f0-9]{64}$/.test(String(cursor.fingerprint || ''))
      || !Number.isFinite(modifiedAt.getTime())) {
      throw new Error(`Invalid durable ADM cursor for ${file.name}`);
    }
    return { file, cursor, modifiedAt };
  });

  await db.transaction(async transactionDb => {
    await transactionDb.run('DELETE FROM low_latency_adm_cursors WHERE server_id = ?', [serverId]);
    for (const { file, cursor, modifiedAt } of records) {
      await transactionDb.run(
        `INSERT INTO low_latency_adm_cursors (
           server_id, remote_path, remote_name, byte_offset, source_line_base,
           previous_line_timestamp, content_fingerprint, remote_size,
           remote_modified_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, clock_timestamp())`,
        [
          serverId,
          file.remotePath,
          file.name,
          cursor.offset,
          cursor.sourceLineBase,
          cursor.previousLineTimestamp,
          cursor.fingerprint,
          file.size,
          modifiedAt.toISOString(),
        ]
      );
    }
  });
}

function reduceAuthoritativeOnlineUpdates(priorState, updates, resetFiles = []) {
  let anchored = Boolean(priorState?.anchored);
  let anchorFileName = priorState?.anchorFileName || null;
  const players = new Map(priorState?.players || []);
  if (anchored && resetFiles.includes(anchorFileName)) {
    anchored = false;
    anchorFileName = null;
    players.clear();
  }
  let changed = false;
  let sourceFileName = null;
  let observedAt = null;

  for (const update of updates || []) {
    if (update.type === 'snapshot_invalid') {
      anchored = false;
      anchorFileName = null;
      players.clear();
      changed = false;
      sourceFileName = null;
      observedAt = null;
      continue;
    }
    if (
      update.type !== 'snapshot'
      && anchored
      && update.sourceFileName !== anchorFileName
    ) {
      anchored = false;
      anchorFileName = null;
      players.clear();
    }
    if (update.type === 'snapshot') {
      const priorPlayers = anchored && anchorFileName === update.sourceFileName
        ? new Map(players)
        : new Map();
      players.clear();
      for (const player of update.players || []) {
        players.set(player.platformUserId, {
          ...player,
          loginAt: priorPlayers.get(player.platformUserId)?.loginAt || update.observedAt,
        });
      }
      anchored = true;
      anchorFileName = update.sourceFileName;
      changed = true;
    } else if (anchored && update.type === 'connect') {
      players.set(update.platformUserId, {
        playerGamertag: update.playerGamertag,
        platformUserId: update.platformUserId,
        loginAt: update.loginAt,
      });
      changed = true;
    } else if (anchored && update.type === 'disconnect') {
      players.delete(update.platformUserId);
      changed = true;
    } else {
      continue;
    }
    sourceFileName = update.sourceFileName;
    observedAt = update.observedAt || update.loginAt || observedAt;
  }

  return {
    state: { anchored, anchorFileName, players },
    snapshot: anchored && changed ? {
      sourceFileName,
      observedAt,
      players: Array.from(players.values()),
    } : null,
  };
}

function createLowLatencyAdmIngestion({
  db,
  loadTargets = loadLowLatencyAdmTargets,
  decryptToken = decryptStoredToken,
  syncLatestAdm = syncLatestAdmForExactServer,
  ingestAdmFiles = ingestExactServerAdmFiles,
  publishOnlineSnapshot = publishExactServerOnlineSnapshot,
  loadCursors = loadPersistedAdmCursors,
  saveCursors = persistAdmCursors,
  processServerFeeds = processServerFeedEvents,
  acquireLocks = acquireExactServerLogLocks,
  concurrency = 2,
  intervalSeconds = 30,
  beginStatus = beginPipelineRun,
  finishStatus = finishPipelineRun,
  availabilityTracker = providerLogAvailability,
  nowMs = Date.now,
  logger = console,
}) {
  const parsedMarkers = new Map();
  const admCursorsByServer = new Map();
  const onlineStatesByServer = new Map();
  const runningServerIds = new Set();
  let tickRunning = false;
  const workerCount = Math.max(1, Math.min(10, Math.floor(Number(concurrency) || 2)));

  async function runTarget(target) {
    const exactServerId = Number(target.serverId);
    const platformServerId = String(target.platformServerId);
    if (!availabilityTracker.canAttempt(platformServerId, nowMs())) {
      return { status: 'skipped', kills: 0, errorCode: 'LOG_STORAGE_BACKOFF' };
    }
    if (runningServerIds.has(exactServerId)) {
      return { status: 'skipped', kills: 0 };
    }

    runningServerIds.add(exactServerId);
    let ingestionLock = null;
    let pipelineRun = null;
    let outcome = { status: 'failed', kills: 0, errorCode: 'ADM_INGESTION_FAILED' };
    try {
      ingestionLock = await acquireLocks(db, [exactServerId]);
      if (!ingestionLock) {
        outcome = { status: 'skipped', kills: 0, errorCode: 'INGESTION_LOCK_BUSY' };
        return outcome;
      }

      try {
        pipelineRun = await beginStatus(db, {
          serverId: exactServerId,
          pipeline: PIPELINES.LOW_LATENCY_ADM,
          intervalSeconds,
        });
      } catch (error) {
        logger.error?.(`[ADM low-latency] failed to record start for server ${exactServerId}:`, error.message);
      }
      const token = decryptToken(target.tokenHash);
      const synced = await syncLatestAdm(db, exactServerId, token);
      availabilityTracker.recordAvailable(platformServerId);
      if (!synced.changed && parsedMarkers.get(exactServerId) === synced.marker) {
        outcome = { status: 'succeeded', kills: 0, errorCode: null };
        return outcome;
      }

      if (!Array.isArray(synced.admFiles) || synced.admFiles.length === 0) {
        throw new Error('No synchronized ADM generation was available for incremental ingestion');
      }
      let currentCursors = admCursorsByServer.get(exactServerId);
      if (!currentCursors) {
        currentCursors = await loadCursors(db, exactServerId);
        if (!(currentCursors instanceof Map)) {
          throw new Error('Durable ADM cursor loader did not return a cursor map');
        }
      }
      const ingestionResult = await ingestAdmFiles(
        db,
        synced.platformServerId,
        token,
        exactServerId,
        synced.admFiles,
        currentCursors
      );
      if (!ingestionResult || !(ingestionResult.cursors instanceof Map)) {
        throw new Error('Incremental ADM ingestion did not return a cursor state');
      }
      const currentAdmFile = [...synced.admFiles].sort((left, right) => compareLogFileEntries(
        { name: left.name, mtimeMs: providerModifiedAtMs(left.modifiedAt) },
        { name: right.name, mtimeMs: providerModifiedAtMs(right.modifiedAt) }
      )).at(-1);
      const priorOnlineState = onlineStatesByServer.get(exactServerId);
      const onlineResetFiles = [...(ingestionResult.onlineResetFiles || [])];
      if (
        priorOnlineState?.anchored
        && priorOnlineState.anchorFileName !== currentAdmFile?.name
      ) {
        onlineResetFiles.push(priorOnlineState.anchorFileName);
      }
      let reducedOnlineState = reduceAuthoritativeOnlineUpdates(
        priorOnlineState,
        ingestionResult.onlineUpdates,
        onlineResetFiles
      );
      if (
        reducedOnlineState.state.anchored
        && reducedOnlineState.state.anchorFileName !== currentAdmFile?.name
      ) {
        reducedOnlineState = reduceAuthoritativeOnlineUpdates(
          reducedOnlineState.state,
          [],
          [reducedOnlineState.state.anchorFileName]
        );
      }
      if (reducedOnlineState.snapshot) {
        const sourceFile = synced.admFiles.find(file =>
          file.name === reducedOnlineState.snapshot.sourceFileName
        );
        const sourceObservedMs = providerModifiedAtMs(sourceFile?.modifiedAt);
        if (sourceObservedMs === null) {
          throw new Error('Incremental online snapshot lacks exact provider observation time');
        }
        await publishOnlineSnapshot(
          db,
          synced.platformServerId,
          token,
          exactServerId,
          reducedOnlineState.snapshot,
          new Date(sourceObservedMs).toISOString()
        );
      }
      onlineStatesByServer.set(exactServerId, reducedOnlineState.state);
      await saveCursors(db, exactServerId, synced.admFiles, ingestionResult.cursors);
      admCursorsByServer.set(exactServerId, ingestionResult.cursors);
      parsedMarkers.set(exactServerId, synced.marker);

      const kills = Number(ingestionResult.killEvents || 0);
      if (kills > 0) {
        await processServerFeeds(db, target.guildId, exactServerId);
      }
      outcome = { status: 'succeeded', kills, errorCode: null };
      return outcome;
    } catch (error) {
      if (error instanceof ProviderLogStorageUnavailableError
          || error?.code === 'LOG_STORAGE_UNAVAILABLE') {
        availabilityTracker.recordUnavailable(platformServerId, nowMs());
        outcome = { status: 'failed', kills: 0, errorCode: 'LOG_STORAGE_UNAVAILABLE' };
      }
      logger.error(`Low-latency ADM ingestion failed for server ${exactServerId}:`, error.message);
      return outcome;
    } finally {
      if (ingestionLock) {
        await ingestionLock.release().catch(error => {
          logger.error?.(`[ADM low-latency] failed to release lock for server ${exactServerId}:`, error.message);
        });
      }
      if (pipelineRun) {
        const state = outcome.status === 'succeeded' ? 'healthy' : 'failed';
        await finishStatus(db, pipelineRun, {
          status: state,
          errorCode: outcome.errorCode,
          counters: { kills: outcome.kills },
        }).catch(error => {
          logger.error?.(`[ADM low-latency] failed to record completion for server ${exactServerId}:`, error.message);
        });
      }
      runningServerIds.delete(exactServerId);
    }
  }

  async function runOnce() {
    if (tickRunning) {
      return { targets: 0, succeeded: 0, failed: 0, skipped: 0, kills: 0 };
    }
    tickRunning = true;
    try {
      const targets = await loadTargets(db);
      const outcomes = new Array(targets.length);
      let nextIndex = 0;
      await Promise.all(Array.from(
        { length: Math.min(workerCount, targets.length) },
        async () => {
          while (nextIndex < targets.length) {
            const index = nextIndex++;
            outcomes[index] = await runTarget(targets[index]);
          }
        }
      ));
      return {
        targets: targets.length,
        succeeded: outcomes.filter(outcome => outcome.status === 'succeeded').length,
        failed: outcomes.filter(outcome => outcome.status === 'failed').length,
        skipped: outcomes.filter(outcome => outcome.status === 'skipped').length,
        kills: outcomes.reduce((total, outcome) => total + outcome.kills, 0),
      };
    } finally {
      tickRunning = false;
    }
  }

  return { runOnce, runTarget };
}

function lowLatencyIntervalSeconds(value = process.env.LOW_LATENCY_ADM_INTERVAL_SECONDS) {
  if (value === undefined || value === null || value === '') return 30;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 30;
  return Math.max(15, Math.min(300, Math.round(parsed)));
}

function startLowLatencyAdmIngestion(db, {
  intervalSeconds = lowLatencyIntervalSeconds(),
  setIntervalFn = setInterval,
  ...dependencies
} = {}) {
  const normalizedIntervalSeconds = lowLatencyIntervalSeconds(intervalSeconds);
  const service = createLowLatencyAdmIngestion({
    db,
    intervalSeconds: normalizedIntervalSeconds,
    ...dependencies,
  });
  const run = async () => {
    const result = await service.runOnce();
    if (result.kills > 0 || result.failed > 0) {
      (dependencies.logger || console).log(
        `Low-latency ADM ingestion: ${result.kills} new kill(s), ${result.failed} failure(s)`
      );
    }
    return result;
  };
  const initialRun = run().catch(error => {
    (dependencies.logger || console).error('Low-latency ADM ingestion tick failed:', error.message);
    return { targets: 0, succeeded: 0, failed: 1, skipped: 0, kills: 0 };
  });
  const timer = setIntervalFn(() => run().catch(error => {
    (dependencies.logger || console).error('Low-latency ADM ingestion tick failed:', error.message);
  }), normalizedIntervalSeconds * 1000);
  timer.unref?.();
  return { ...service, initialRun, timer };
}

module.exports = {
  createLowLatencyAdmIngestion,
  loadLowLatencyAdmTargets,
  loadPersistedAdmCursors,
  persistAdmCursors,
  lowLatencyIntervalSeconds,
  startLowLatencyAdmIngestion,
};
