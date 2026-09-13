/**
 * Log Scan Service
 *
 * Re-exports the standalone log-scanner from the logParser route module so
 * that the scheduler (and any future consumers) can depend on a stable
 * service interface rather than importing directly from a route file.
 */

const {
  scanLogsForServer,
  ingestExactServerAdmFiles,
  publishExactServerOnlineSnapshot,
} = require('../routes/logParser');

async function scanExactServerLogs(
  db,
  platformServerId,
  token,
  internalServerId,
  options = {}
) {
  return scanLogsForServer(db, null, platformServerId, token, {
    ...options,
    internalServerId,
    systemAuthorizedInternalServerId: internalServerId,
  });
}

module.exports = {
  scanExactServerLogs,
  scanLogsForServer,
  ingestExactServerAdmFiles,
  publishExactServerOnlineSnapshot,
};
