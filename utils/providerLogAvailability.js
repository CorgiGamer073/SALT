'use strict';

class ProviderLogStorageUnavailableError extends Error {
  constructor(serverId) {
    super(`No DayZ config directory found for server ${serverId}`);
    this.name = 'ProviderLogStorageUnavailableError';
    this.code = 'LOG_STORAGE_UNAVAILABLE';
  }
}

function createProviderLogAvailabilityTracker({
  baseBackoffMs = 5 * 60 * 1000,
  maxBackoffMs = 60 * 60 * 1000,
} = {}) {
  const unavailable = new Map();
  const baseMs = Math.max(1000, Number(baseBackoffMs) || 5 * 60 * 1000);
  const maxMs = Math.max(baseMs, Number(maxBackoffMs) || 60 * 60 * 1000);

  function recordUnavailable(serverId, nowMs = Date.now()) {
    const key = String(serverId);
    const previous = unavailable.get(key);
    const failures = (previous?.failures || 0) + 1;
    const delayMs = Math.min(maxMs, baseMs * (2 ** Math.min(failures - 1, 10)));
    const retryAtMs = Number(nowMs) + delayMs;
    unavailable.set(key, { failures, retryAtMs });
    return retryAtMs;
  }

  function recordAvailable(serverId) {
    unavailable.delete(String(serverId));
  }

  function retryAt(serverId) {
    return unavailable.get(String(serverId))?.retryAtMs ?? null;
  }

  function canAttempt(serverId, nowMs = Date.now()) {
    const retryAtMs = retryAt(serverId);
    return retryAtMs === null || Number(nowMs) >= retryAtMs;
  }

  return { canAttempt, recordAvailable, recordUnavailable, retryAt };
}

const providerLogAvailability = createProviderLogAvailabilityTracker();

module.exports = {
  ProviderLogStorageUnavailableError,
  createProviderLogAvailabilityTracker,
  providerLogAvailability,
};
