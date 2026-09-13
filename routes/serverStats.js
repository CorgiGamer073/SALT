/*
 * routes/serverStats.js
 *
 * Proxy for Nitrado gameserver statistics (player count, CPU, memory over time).
 * Raw data is downsampled before sending to keep chart rendering fast.
 *
 *   GET /api/stats/:serverId?hours=24  — returns downsampled timeseries data
 *
 * Requires authentication. Token is resolved from the guild that owns the server.
 */

const express = require('express');
const router = express.Router();
const { getGuildTokenForExactServer } = require('../utils/guildTokens');
const { requireServerCapability } = require('../middleware/serverAccess');
const { CAPABILITIES } = require('../services/authorizationService');
const { loadServerOverview } = require('../services/serverMetricsService');
const nitradoService = require('../services/nitradoService');
const { sendExternalApiError } = require('../utils/externalApiResponse');

router.use('/:serverId', requireServerCapability(CAPABILITIES.SERVER_MODERATE));

const MAX_CHART_POINTS = 120;

async function resolveToken(db, authorization) {
  const { id: serverId, platformServerId } = authorization.server;
  const token = await getGuildTokenForExactServer(db, serverId, authorization.guild.id);
  if (!token) return { error: 'No Nitrado token found for this server', status: 403 };

  return { token, platformServerId };
}

/**
 * Evenly downsample an array to at most maxPoints entries.
 * Each entry is [value, unixTimestamp] from the Nitrado stats API.
 */
function downsample(arr, maxPoints) {
  if (!arr || arr.length <= maxPoints) return arr || [];
  const step = Math.ceil(arr.length / maxPoints);
  return arr.filter((_, i) => i % step === 0);
}

/**
 * GET /api/stats/:serverId/overview
 * Return the exact-server operational snapshot. Optional provider failures are
 * represented as warnings so database-backed health remains available.
 */
router.get('/:serverId/overview', async (req, res) => {
  try {
    const overview = await loadServerOverview({
      db: req.app.locals.db,
      authorization: req.authorization,
      tokenResolver: getGuildTokenForExactServer,
      nitrado: nitradoService,
    });
    if (!overview) return res.status(404).json({ error: 'Resource not found' });
    return res.json(overview);
  } catch (error) {
    console.error('Failed to load server health overview:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to load server health overview' });
  }
});

/**
 * GET /api/stats/:serverId
 * Query params: hours=6|12|24|48 (defaults to 24)
 *
 * Returns downsampled timeseries for players, CPU %, and memory %.
 */
router.get('/:serverId', async (req, res) => {
  const db = req.app.locals.db;
  const { token, platformServerId, error, status } = await resolveToken(db, req.authorization);
  if (error) return res.status(status).json({ success: false, error });

  const hours = Math.min(48, Math.max(1, parseInt(req.query.hours, 10) || 24));

  try {
    const raw = await nitradoService.getStats(token, platformServerId, hours);

    // Each metric from Nitrado is an array of [value, unixTimestampSeconds]
    const players    = downsample(raw.currentPlayers || [], MAX_CHART_POINTS);
    const cpu        = downsample(raw.cpuUsage       || [], MAX_CHART_POINTS);
    const memory     = downsample(raw.memoryUsage    || [], MAX_CHART_POINTS);
    const maxPlayers = downsample(raw.maxPlayers     || [], MAX_CHART_POINTS);

    // Build time labels from whichever metric has data
    const base = players.length ? players : cpu.length ? cpu : memory;
    const labels = base.map(([, ts]) => {
      const d = new Date(ts * 1000);
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    });

    res.json({
      success: true,
      hours,
      labels,
      players:    players.map(([v]) => v),
      cpu:        cpu.map(([v]) => v),
      memory:     memory.map(([v]) => v),
      maxPlayers: maxPlayers.map(([v]) => v),
    });
  } catch (err) {
    sendExternalApiError(res, err, 'Nitrado');
  }
});

module.exports = router;
