'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildOperationsMapSnapshot,
  parseWindowMinutes,
  isSupportedMapName,
} = require('../services/operationsMapService');
const { activeSessionContext } = require('../routes/operationsMap');
const { listModeratableGuilds } = require('../src/app/registerRoutes');

function fixtureDb(overrides = {}) {
  const rows = {
    snapshot: {
      source_observed_at: '2026-09-07T18:59:00.000Z',
      published_at: '2026-09-07T18:59:02.000Z',
    },
    players: [
      {
        identity_id: 7, gamertag: 'Survivor', login_at: '2026-09-07T18:40:00.000Z',
        position_observed_at: '2026-09-07T18:58:30.000Z', pos_x: 1200, pos_y: 3400, pos_z: 12,
      },
      {
        identity_id: 8, gamertag: 'OldPosition', login_at: '2026-09-07T18:40:00.000Z',
        position_observed_at: '2026-09-07T18:20:00.000Z', pos_x: 999, pos_y: 999, pos_z: 9,
      },
    ],
    kills: [{ id: 1, killer_gamertag: 'A', victim_gamertag: 'B', weapon: 'M4', distance: 80,
      timestamp: '2026-09-07T18:55:00.000Z', east: 1300, north: 3500 }],
    deaths: [], damage: [],
    territory: [{ id: 2, gamertag: 'Builder', event_type: 'placed', structure_type: 'FenceKit',
      structure_part: null, tool_used: null, pos_x: 1400, pos_y: 3600, pos_z: 9,
      timestamp: '2026-09-07T18:56:00.000Z' }],
    purchases: [
      { id: 3, identity_id: 7, gamertag: 'Survivor', item_name: 'Truck', item_class: 'Truck_01',
        quantity: 1, spawn_method: 'event', is_active: 1, pos_x: 1500, pos_y: 8, pos_z: 3700,
        checked_out_at: '2026-09-07T18:50:00.000Z' },
      { id: 4, identity_id: 7, gamertag: 'Survivor', item_name: 'Radar', item_class: null,
        quantity: 1, spawn_method: 'capability', is_active: 1, pos_x: 0, pos_y: 0, pos_z: 0,
        checked_out_at: '2026-09-07T18:55:00.000Z' },
    ],
    markers: [{ id: 4, faction_id: 8, faction_name: 'Wardens', title: 'North post', note: '', icon: '📍',
      pos_x: 1600, pos_y: 3800, updated_at: '2026-09-07T18:30:00.000Z' }],
    zones: [
      { id: 5, zone_type: 'territory_flag', center_x: 1700, center_z: 3900, radius_meters: 150,
        status: 'confirmed', first_evidence_at: '2026-09-07T18:45:00.000Z',
        evidence_observed_at: '2026-09-07T18:50:00.000Z' },
      { id: 6, zone_type: 'territory_flag', center_x: 999, center_z: 999, radius_meters: 150,
        status: 'confirmed', first_evidence_at: '2026-09-07T17:00:00.000Z',
        evidence_observed_at: '2026-09-07T18:50:00.000Z' },
    ],
    ...overrides,
  };
  return {
    async get(sql) {
      if (sql.includes('server_online_cache_snapshots')) return rows.snapshot;
      throw new Error(`Unexpected get: ${sql}`);
    },
    async query(sql) {
      if (sql.includes('FROM server_online_cache cache')) return rows.players;
      if (sql.includes('FROM kill_events')) return rows.kills;
      if (sql.includes('FROM player_death_events')) return rows.deaths;
      if (sql.includes('FROM damage_events')) return rows.damage;
      if (sql.includes('FROM territory_events')) return rows.territory;
      if (sql.includes('FROM shop_order_items')) return rows.purchases;
      if (sql.includes('FROM faction_markers')) return rows.markers;
      if (sql.includes('FROM spawn_exclusion_zones')) return rows.zones;
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

async function testExactServerProjectionAndCoordinateSemantics() {
  const snapshot = await buildOperationsMapSnapshot({
    db: fixtureDb(),
    serverId: 41,
    mapName: 'chernarusplus',
    windowMinutes: 60,
    activeSessionStartedAt: '2026-09-07T18:30:00.000Z',
    now: new Date('2026-09-07T19:00:00.000Z'),
  });
  assert.strictEqual(snapshot.success, true);
  assert.strictEqual(snapshot.serverId, 41);
  assert.strictEqual(snapshot.mapName, 'chernarusplus');
  assert.strictEqual(snapshot.telemetry.mode, 'log-derived');
  assert.strictEqual(snapshot.telemetry.presenceFresh, true);
  assert.strictEqual(snapshot.rosterPlayers.length, 1);
  assert.deepStrictEqual(snapshot.rosterPlayers[0].position, { east: 1200, north: 3400, elevation: 12 });
  assert.strictEqual(snapshot.rosterPlayers[0].positionFresh, true);
  assert.deepStrictEqual(snapshot.recentEvents[0].position, { east: 1300, north: 3500, elevation: null });
  assert.deepStrictEqual(snapshot.territoryObservations[0].position, { east: 1400, north: 3600, elevation: 9 });
  assert.deepStrictEqual(snapshot.purchases[0].position, { east: 1500, north: 3700, elevation: 8 });
  assert.strictEqual(snapshot.purchases.length, 1);
  assert.strictEqual(snapshot.purchases[0].spawnMethod, 'event');
  assert.strictEqual(snapshot.purchases[0].presence, 'unknown');
  assert.strictEqual(snapshot.factionMarkers[0].kind, 'marker_not_territory');
  assert.strictEqual(snapshot.zones.length, 1);
  assert.strictEqual(snapshot.zones[0].status, 'confirmed');
}

async function testStalePresenceNeverClaimsOnlinePlayers() {
  const snapshot = await buildOperationsMapSnapshot({
    db: fixtureDb({ snapshot: {
      source_observed_at: '2026-09-07T16:00:00.000Z',
      published_at: '2026-09-07T16:00:02.000Z',
    } }),
    serverId: 41,
    mapName: 'enoch',
    activeSessionStartedAt: '2026-09-07T18:30:00.000Z',
    now: new Date('2026-09-07T19:00:00.000Z'),
  });
  assert.strictEqual(snapshot.telemetry.presenceFresh, false);
  assert.deepStrictEqual(snapshot.rosterPlayers, []);
}

async function testModeratableGuildDiscovery() {
  let captured;
  const expected = [{ id: 'guild-1', name: 'Guild', icon: null }];
  const db = {
    async query(sql, params) {
      captured = { sql, params };
      return expected;
    },
  };
  assert.deepStrictEqual(await listModeratableGuilds(db, 17), expected);
  assert.deepStrictEqual(captured.params, [17, 17]);
  assert.match(captured.sql, /sra\.role IN \('admin', 'moderator'\)/);
  assert.match(captured.sql, /sra\.status = 'active'/);
  assert.match(captured.sql, /s\.status = 'active'/);
}

function testBoundsAndFrontendContract() {
  assert.deepStrictEqual(activeSessionContext({
    status: 'started',
    settings: { config: { mission: 'dayzOffline.enoch' } },
    query: { map: 'dayzOffline.chernarusplus' },
    last_status_change: 1788805800,
  }), {
    mapName: 'chernarusplus',
    startedAt: '2026-09-07T18:30:00.000Z',
  });
  assert.strictEqual(activeSessionContext({
    status: 'stopped',
    query: { map: 'chernarusplus' },
    last_status_change: 1788820200,
  }), null);
  assert.strictEqual(activeSessionContext({
    status: 'started',
    query: { map: 'unsupported' },
    last_status_change: 1788820200,
  }), null);
  assert.strictEqual(isSupportedMapName('enoch'), true);
  assert.strictEqual(isSupportedMapName('namalsk'), false);
  assert.strictEqual(isSupportedMapName('unsupported'), false);
  assert.strictEqual(parseWindowMinutes('1'), 15);
  assert.strictEqual(parseWindowMinutes('9999'), 1440);
  assert.strictEqual(parseWindowMinutes('nope'), 60);

  const serviceSource = fs.readFileSync(path.join(__dirname, '../services/operationsMapService.js'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '../routes/operationsMap.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../src/app/registerRoutes.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/map.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '../public/js/map.js'), 'utf8');
  const lootRoute = fs.readFileSync(path.join(__dirname, '../routes/lootFinder.js'), 'utf8');
  const indexMigration = fs.readFileSync(path.join(__dirname, '../db/migrations/090_operations_map_indexes.js'), 'utf8');
  assert.match(route, /requireServerCapability\(CAPABILITIES\.SERVER_MODERATE\)/);
  assert.match(route, /const \{ server, guild \} = req\.authorization/);
  assert.match(route, /getGuildTokenForExactServer\(db, server\.id, guild\.id\)/);
  assert.match(route, /activeSessionStartedAt: activeSession\.startedAt/);
  assert.match(route, /gameserver\?\.status !== 'started'/);
  assert.match(route, /gameserver\?\.query\?\.map/);
  assert.doesNotMatch(route, /settings\?\.config\?\.mission \|\| gameserver\?\.query/);
  assert.match(serviceSource, /snapshot\.timestamp >= \?/);
  assert.match(serviceSource, /soi\.spawn_method IN \('cfgEffectArea', 'custom_json', 'event'\)/);
  assert.match(serviceSource, /first_evidence_at >= \? AND last_evidence_at >= \?/);
  assert.match(app, /app\.use\('\/api\/operations-map'/);
  assert.match(app, /app\.get\('\/map'[^\n]*ensureHasModeratableServers/);
  assert.match(app, /\/api\/user\/moderatable-guilds/);
  for (const id of ['operations-player-toggle', 'operations-event-toggle', 'operations-purchase-toggle',
    'operations-territory-toggle', 'operations-zone-toggle', 'operations-faction-toggle', 'operations-status']) {
    assert(html.includes(`id="${id}"`), `missing ${id}`);
  }
  assert.match(client, /\/api\/user\/moderatable-guilds/);
  assert.match(client, /servers\?scope=moderate/);
  assert.match(client, /dataset\.internalServerId/);
  assert.match(client, /\/api\/operations-map\//);
  assert.match(client, /log-derived/i);
  assert.match(client, /function clearSelectedContext\(\) \{\s*currentMapName = null;/);
  assert.match(client, /if \(!response\.ok \|\| !result\.success\) \{\s*clearOperationsLayers\(\)/);
  assert.match(client, /catch \(error\) \{[\s\S]*?clearOperationsLayers\(\);\s*status\.textContent = 'Operations telemetry is unavailable\.'/);
  assert.match(client, /mapDefinition\.verifiedGeometry/);
  assert.match(client, /Roster observation:/);
  assert.match(client, /presence[^\n]*unknown/i);
  assert.match(indexMigration, /shop_order_items \(order_id, id DESC\)/);
  assert.match(indexMigration, /faction_markers \(server_id, LOWER\(map_name\), updated_at DESC, id DESC\)/);
  assert.match(indexMigration, /spawn_exclusion_zones \(server_id, last_evidence_at DESC, id DESC\)/);
  assert.match(lootRoute, /FLOOR\(pos_x \/ \$3\)/);
  assert.match(lootRoute, /FLOOR\(pos_z \/ \$3\)/);
  assert.doesNotMatch(lootRoute, /ROUND\(pos_[xz] \/ \$3\)/);
}

(async () => {
  await testExactServerProjectionAndCoordinateSemantics();
  await testStalePresenceNeverClaimsOnlinePlayers();
  await testModeratableGuildDiscovery();
  testBoundsAndFrontendContract();
  console.log('Operations map tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
