'use strict';

const express = require('express');
const { requireServerCapability } = require('../middleware/serverAccess');
const { CAPABILITIES } = require('../services/authorizationService');
const {
  buildOperationsMapSnapshot,
  parseWindowMinutes,
  isSupportedMapName,
} = require('../services/operationsMapService');
const { getGuildTokenForExactServer } = require('../utils/guildTokens');
const nitradoService = require('../services/nitradoService');

const router = express.Router();
const SUPPORTED_MAP_PATTERN = /(?:^|\.)(chernarusplus|enoch|sakhal|namalsk|takistanplus)(?:$|\.)/i;

function activeSessionContext(gameserver) {
  if (gameserver?.status !== 'started') return null;
  const liveMap = gameserver?.query?.map;
  const match = String(liveMap || '').match(SUPPORTED_MAP_PATTERN);
  const rawStartedAt = Number(gameserver?.last_status_change);
  const startedAtMs = rawStartedAt < 1e12 ? rawStartedAt * 1000 : rawStartedAt;
  if (!match || !Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
  return { mapName: match[1].toLowerCase(), startedAt: new Date(startedAtMs).toISOString() };
}

router.get('/:serverId', requireServerCapability(CAPABILITIES.SERVER_MODERATE), async (req, res) => {
  const mapName = String(req.query.map || '').trim().toLowerCase();
  if (!isSupportedMapName(mapName)) {
    return res.status(400).json({ success: false, error: 'A supported map is required' });
  }

  try {
    const db = req.app.locals.db;
    const { server, guild } = req.authorization;
    const token = await getGuildTokenForExactServer(db, server.id, guild.id);
    if (!token) return res.status(503).json({ success: false, error: 'Active map verification is unavailable' });
    const gameserver = await nitradoService.getRawGameserver(token, server.platformServerId);
    const activeSession = activeSessionContext(gameserver);
    if (!activeSession) {
      return res.status(503).json({ success: false, error: 'Active map verification is unavailable' });
    }
    if (activeSession.mapName !== mapName) {
      return res.status(409).json({
        success: false,
        error: 'Selected map is not the active server map',
        activeMapName: activeSession.mapName,
      });
    }
    const snapshot = await buildOperationsMapSnapshot({
      db,
      serverId: server.id,
      mapName: activeSession.mapName,
      activeSessionStartedAt: activeSession.startedAt,
      windowMinutes: parseWindowMinutes(req.query.windowMinutes),
    });
    return res.json(snapshot);
  } catch (error) {
    console.error('Failed to load operations map:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to load operations map' });
  }
});

module.exports = router;
module.exports.activeSessionContext = activeSessionContext;
