'use strict';

(function exposeServerStatsState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ServerStatsState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  async function readJsonForContext(response, isCurrent) {
    const body = await response.json().catch(() => ({}));
    if (!isCurrent()) return { stale: true, body: null };
    if (!response.ok || body.success === false) {
      const error = new Error(body.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return { stale: false, body };
  }

  function count(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
  }

  function pipelineWorkload(id, counters = {}) {
    if (id === 'pipelineFeed') {
      return `${count(counters.pending)} pending · ${count(counters.retrying)} retrying · ${count(counters.failed)} failed`;
    }
    if (id === 'pipelineFullSync') {
      return `${count(counters.parsedServers)} parsed this run`;
    }
    return `${count(counters.kills)} new kills`;
  }

  return { pipelineWorkload, readJsonForContext };
});
