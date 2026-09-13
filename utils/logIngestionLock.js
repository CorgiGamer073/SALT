'use strict';

const LOG_INGESTION_LOCK_NAMESPACE = 0x4c4f4749;

async function acquireExactServerLogLocks(db, serverIds) {
  const ids = [...new Set(serverIds.map(Number))].sort((left, right) => left - right);
  if (ids.length === 0 || ids.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 0x7fffffff)) {
    throw new Error('Exact server log locks require positive integer server IDs');
  }
  if (typeof db?.acquireSessionAdvisoryLocks !== 'function') {
    if (db?.type === 'postgres' || db?.constructor?.name === 'PostgresAdapter') {
      throw new Error('PostgreSQL exact-server advisory locking is unavailable');
    }
    return { async release() {} };
  }
  return db.acquireSessionAdvisoryLocks(LOG_INGESTION_LOCK_NAMESPACE, ids);
}

module.exports = {
  LOG_INGESTION_LOCK_NAMESPACE,
  acquireExactServerLogLocks,
};
