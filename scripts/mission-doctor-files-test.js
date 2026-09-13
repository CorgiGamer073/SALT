'use strict';

// Offline fixtures only: never initialize a database or contact a provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const SERVICE = path.join(__dirname, '..', 'services', 'missionFileInspectionService.js');
function service() {
  assert.ok(fs.existsSync(SERVICE), 'bounded working-copy inspection service must exist');
  return require(SERVICE);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-doctor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (name, content) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  };
  return { root, put };
}

test('repair read admission rejects unsafe paths, nonregular files, oversize and invalid UTF-8', t => {
  const { root, put } = fixture(t);
  put('good.xml', '<types/>');
  put('bad.json', Buffer.from([0xc3, 0x28]));
  put('plain.txt', 'no');
  put('large.xml', Buffer.alloc(5 * 1024 * 1024 + 1));
  fs.mkdirSync(path.join(root, 'dir.xml'));
  fs.symlinkSync('good.xml', path.join(root, 'link.xml'));
  fs.symlinkSync(root, path.join(root, 'alias'));
  for (const fileName of ['../good.xml', './good.xml', 'x/../good.xml', '/good.xml',
    'alias/good.xml', 'link.xml', 'dir.xml', 'plain.txt', 'large.xml', 'bad.json',
    'good.xml%00', 'x\\\\good.xml']) {
    assert.throws(() => service().readWorkingCopyFile(root, fileName),
      error => Number.isInteger(error.status) && !error.message.includes(root), fileName);
  }
  assert.equal(service().MAX_FILE_BYTES, 5 * 1024 * 1024);
});

test('repair reads detect changes during a bounded positional snapshot', t => {
  const { root, put } = fixture(t);
  put('live.json', '{"v":1}');
  const originalRead = fs.readSync;
  let injected = false;
  fs.readSync = function(fd, buffer, offset, length, position) {
    assert.equal(typeof position, 'number');
    if (!injected) {
      injected = true;
      fs.appendFileSync(path.join(root, 'live.json'), 'trailing bytes');
    }
    return originalRead.call(fs, fd, buffer, offset, Math.min(length, 2), position);
  };
  try {
    assert.throws(() => service().readWorkingCopyFile(root, 'live.json'), { code: 'FILE_CHANGED', status: 409 });
  } finally { fs.readSync = originalRead; }
});

test('discovery includes mission subdirectories but skips runtime and unsafe entries deterministically', t => {
  const { root, put } = fixture(t);
  for (const dir of ['db', 'custom', 'env', 'pra', 'storage_1', 'storage', 'logs', 'log', 'node_modules', '.hidden']) {
    put(`mpmissions/dayzOffline.test/${dir}/file.xml`, '<broken>');
  }
  put('z.json', '{'); put('a.xml', '<a>'); put('.hidden.xml', '<hidden/>');
  fs.symlinkSync('a.xml', path.join(root, 'link.xml'));
  const api = service();
  assert.equal(typeof api.discoverWorkingCopyFiles, 'function');
  const result = api.discoverWorkingCopyFiles(root);
  const expected = ['a.xml', ...['custom', 'db', 'env', 'pra'].map(dir => `mpmissions/dayzOffline.test/${dir}/file.xml`), 'z.json'];
  assert.deepEqual(Object.keys(result.files), expected);
  assert.equal(result.truncated, false);
  assert.deepEqual(api.discoverWorkingCopyFiles(root), result);
  assert.equal(result.files['z.json'].type, 'json');
  assert.ok(!JSON.stringify(result).includes(root));
});

test('discovery bounds depth, entries, and files with explicit deterministic truncation', t => {
  const { root, put } = fixture(t);
  for (const name of ['z.xml', 'a.xml', 'b/c/d.xml']) put(name, '<x/>');
  for (const [limits, reason] of [[{ maxFiles: 1 }, 'MAX_FILES'], [{ maxEntries: 1 }, 'MAX_ENTRIES'], [{ maxDepth: 0 }, 'MAX_DEPTH']]) {
    const result = service().discoverWorkingCopyFiles(root, limits);
    assert.equal(result.truncated, true, reason);
    assert.ok(result.diagnostics.some(item => item.code === reason));
    assert.deepEqual(service().discoverWorkingCopyFiles(root, limits), result);
    if (limits.maxFiles) assert.equal(Object.keys(result.files).length, 1);
    if (limits.maxEntries) {
      assert.ok(result.scannedEntries <= limits.maxEntries);
      assert.equal(Object.keys(result.files).length, 0, 'discard incomplete directory, not filesystem-order-dependent prefix');
    }
  }
});

test('registration metadata uses only declared runtime dependencies', t => {
  const { root, put } = fixture(t);
  const mission = 'mpmissions/dayzOffline.test';
  put(`${mission}/types.xml`, '<types/>');
  put(`${mission}/cfgeconomycore.xml`, '<economycore><ce folder="."><file name="types.xml" type="types"/></ce></economycore>');
  const Module = require('node:module');
  const declared = require('../package.json').dependencies;
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function(name) {
    if (this.filename === SERVICE && !name.startsWith('.') && !Module.isBuiltin(name)) {
      assert.ok(declared[name], `undeclared runtime dependency: ${name}`);
    }
    return originalRequire.call(this, name);
  };
  try { assert.equal(service().readWorkingCopyFile(root, `${mission}/types.xml`).documentType, 'types.xml'); }
  finally { Module.prototype.require = originalRequire; }
});

test('registered custom-file typing reaches the actual document validator', async t => {
  const { root, put } = fixture(t);
  const mission = 'mpmissions/dayzOffline.test';
  put(`${mission}/custom/seasonal.xml`, '<events/>');
  put(`${mission}/cfgeconomycore.xml`, '<economycore><ce folder="custom"><file name="seasonal.xml" type="types"/></ce></economycore>');
  const snapshot = service().readWorkingCopyFile(root, `${mission}/custom/seasonal.xml`);
  const report = await require('../services/validationService').validateXML(`${mission}/custom/seasonal.xml`, snapshot.content, snapshot.documentType);
  assert.equal(report.valid, false, 'registered types document must not silently fall back to syntax-only');
  assert.ok(report.errors.some(item => item.code === 'WRONG_ROOT'));
});

test('exact CE registration annotates custom names within only the selected mission', t => {
  const { root, put } = fixture(t);
  const mission = 'mpmissions/dayzOffline.test';
  put(`${mission}/custom/seasonal.xml`, '<broken>');
  put(`${mission}/cfgeconomycore.xml`, '<economycore><ce folder="custom"><file name="seasonal.xml" type="types"/></ce></economycore>');
  put('mpmissions/dayzOffline.other/custom/seasonal.xml', '<other>');
  const result = service().readWorkingCopyFile(root, `${mission}/custom/seasonal.xml`);
  assert.equal(result.documentType, 'types.xml');
  assert.equal(service().discoverWorkingCopyFiles(root).files[`${mission}/custom/seasonal.xml`].documentType, 'types.xml');
  assert.equal(service().readWorkingCopyFile(root, 'mpmissions/dayzOffline.other/custom/seasonal.xml').documentType, undefined);
});

test('CE metadata fails closed with diagnostics for ambiguous, unsafe, malformed, and bounded registrations', t => {
  const { root, put } = fixture(t);
  const mission = 'mpmissions/dayzOffline.test';
  const name = `${mission}/custom/seasonal.xml`;
  const file = '<file name="seasonal.xml" type="types"/>';
  put(name, '<broken>');
  const cases = [
    `<economycore><ce folder="custom">${file}${file}</ce></economycore>`,
    `<economycore><ce folder="custom">${file}<file name="seasonal.xml" type="events"/></ce></economycore>`,
    `<economycore><ce folder="custom">${file}<file name="Seasonal.xml" type="events"/></ce></economycore>`,
    `<economycore><ce folder="custom">${file}</ce><ce folder="../other"><file name="x.xml" type="types"/></ce></economycore>`,
    `<economycore><ce folder="custom">${file}</ce><ce folder="custom"><file name="x.xml" type="bogus"/></ce></economycore>`,
    `<economycore><ce folder="custom" extra="no">${file}</ce></economycore>`,
    `<economycore><ce folder="custom">${file}<unexpected/></ce></economycore>`,
    `<economycore><ce folder="custom" folder="other">${file}</ce></economycore>`,
    `<economycore><ce folder="custom"><file name="seasonal.xml" name="other.xml" type="types"/></ce></economycore>`,
    `<economycore><ce folder="custom">${file}</ce></economycore><economycore/>`,
    `<economycore><ce folder="custom">${file}</ce>`,
    `<!DOCTYPE economycore [<!ENTITY injected "types">]><economycore><ce folder="custom">${file}</ce></economycore>`,
    `<economycore><ce folder="custom">${file}</ce>${' '.repeat(128 * 1024)}</economycore>`,
    `<economycore><ce folder="custom">${file}${Array.from({ length: 513 }, (_, i) => `<file name="${i}.xml" type="types"/>`).join('')}</ce></economycore>`,
    `<economycore><ce folder="custom">${file}</ce>${'<defaults>'.repeat(20)}${'</defaults>'.repeat(20)}</economycore>`,
  ];
  for (const content of cases) {
    put(`${mission}/cfgeconomycore.xml`, content);
    const result = service().readWorkingCopyFile(root, name);
    assert.equal(result.documentType, undefined, `registration case ${cases.indexOf(content)}`);
    assert.ok(result.diagnostics.length > 0);
    assert.ok(!JSON.stringify(result.diagnostics).includes(root));
  }
});

test('mounted read/list retain SERVER_MANAGE denial and expose repairable malformed XML without mutations', async t => {
  const express = require('express');
  const downloads = path.join(__dirname, '..', 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const guildRoot = fs.mkdtempSync(path.join(downloads, 'doctor-route-'));
  const guildId = path.basename(guildRoot);
  const serverId = 'doctor-test';
  const root = path.join(guildRoot, `server_${serverId}`);
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.writeFileSync(path.join(root, 'db/broken.xml'), '<types><broken>');
  t.after(() => fs.rmSync(guildRoot, { recursive: true, force: true }));
  let prohibitedCalls = 0;
  const forbidden = () => { prohibitedCalls += 1; throw new Error('No provider or mutation calls allowed'); };
  const stub = new Proxy({}, { get: () => forbidden });
  const saved = new Map();
  for (const name of ['../services/missionFileService', '../services/nitradoService', '../services/missionEditorSaveService']) {
    const id = require.resolve(name);
    saved.set(id, require.cache[id]);
    require.cache[id] = { id, filename: id, loaded: true, exports: stub };
  }
  const routeId = require.resolve('../routes/missionFiles');
  const oldRoute = require.cache[routeId];
  delete require.cache[routeId];
  const router = require(routeId);
  t.after(() => {
    for (const [id, previous] of saved) { if (previous) require.cache[id] = previous; else delete require.cache[id]; }
    if (oldRoute) require.cache[routeId] = oldRoute; else delete require.cache[routeId];
  });
  const app = express();
  let mode = 'owner';
  let authReads = 0;
  app.locals.db = new Proxy({ async get(sql, params) {
    authReads += 1;
    assert.match(sql, /sra.guild_id = s.guild_id/);
    assert.match(sql, /s.status = 'active'/);
    assert.match(sql, /g.status = 'approved'/);
    assert.deepEqual(params, [7, 7, 7, serverId]);
    if (mode === 'denied') return null;
    return { server_id: 41, guild_id: 4, platform_server_id: serverId, server_status: 'active',
      guild_status: 'approved', discord_guild_id: guildId, guild_role: mode };
  } }, { get: (target, key) => key in target ? target[key] : forbidden });
  app.use((req, res, next) => {
    req.isAuthenticated = () => mode !== 'anonymous';
    req.user = { id: 7, discord_id: guildId, username: 'fixture' };
    next();
  });
  app.use('/api', router);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/mission-files`;
  for (const denied of ['anonymous', 'moderator', 'denied']) {
    mode = denied;
    for (const url of [`${base}/${serverId}/db/broken.xml`, `${base}/list/${serverId}`]) {
      const before = authReads;
      const response = await fetch(url);
      assert.equal(response.status, denied === 'anonymous' ? 401 : 404);
      const body = await response.json();
      assert.equal(body.content, undefined);
      assert.equal(body.files, undefined);
      if (denied === 'anonymous') assert.equal(authReads, before);
    }
  }
  mode = 'owner';
  const response = await fetch(`${base}/${serverId}/db/broken.xml?documentType=events`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.content, '<types><broken>');
  assert.equal(result.parsedData, null);
  assert.equal(result.documentType, undefined);
  assert.equal(result.source.kind, 'local_working_copy');
  const listing = await (await fetch(`${base}/list/${serverId}`)).json();
  assert.ok(listing.files['db/broken.xml']);
  assert.equal(listing.truncated, false);
  assert.ok(!JSON.stringify(listing).includes(downloads));
  fs.writeFileSync(path.join(root, 'plain.txt'), 'not editable');
  fs.writeFileSync(path.join(root, 'bad.json'), Buffer.from([0xc3, 0x28]));
  fs.writeFileSync(path.join(root, 'large.xml'), Buffer.alloc(5 * 1024 * 1024 + 1));
  fs.symlinkSync('db/broken.xml', path.join(root, 'link.xml'));
  for (const [name, status] of [['plain.txt', 415], ['bad.json', 422], ['large.xml', 413],
    ['link.xml', 400], ['%252e%252e%252foutside.xml', 400], ['missing.xml', 404]]) {
    const rejected = await fetch(`${base}/${serverId}/${name}`);
    assert.equal(rejected.status, status, name);
    const body = await rejected.json();
    assert.equal(body.content, undefined);
    assert.ok(!JSON.stringify(body).includes(downloads));
  }
  assert.equal(prohibitedCalls, 0);
});

test('discovery bounds aggregate CE inspection and reports unresolved exact mission context', t => {
  const { root, put } = fixture(t);
  for (let i = 0; i < 17; i += 1) {
    const mission = `mpmissions/mission${String(i).padStart(2, '0')}`;
    put(`${mission}/custom/x.xml`, '<broken>');
    put(`${mission}/cfgeconomycore.xml`, '<economycore><ce folder="custom"><file name="x.xml" type="types"/></ce></economycore>');
  }
  const result = service().discoverWorkingCopyFiles(root);
  assert.equal(result.files['mpmissions/mission16/custom/x.xml'].documentType, undefined);
  assert.ok(result.files['mpmissions/mission16/custom/x.xml'].diagnostics.some(d => d.code === 'CE_REGISTRATION_LIMIT'));
  assert.equal(result.truncated, true);
  put('orphan.xml', '<x/>');
  assert.ok(service().readWorkingCopyFile(root, 'orphan.xml').diagnostics.some(d => d.code === 'CE_MISSION_UNRESOLVED'));
});

test('a regular-file to FIFO swap cannot block the descriptor reader', t => {
  const { root, put } = fixture(t);
  put('good.xml', '<types/>');
  const { spawnSync } = require('node:child_process');
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const { execFileSync } = require('node:child_process');
    const service = require(${JSON.stringify(SERVICE)});
    const open = fs.openSync;
    let swapped = false;
    fs.openSync = function(name, flags, ...rest) {
      if (!swapped && String(name).endsWith('/good.xml')) {
        swapped = true;
        fs.unlinkSync(${JSON.stringify(path.join(root, 'good.xml'))});
        execFileSync('mkfifo', [${JSON.stringify(path.join(root, 'good.xml'))}]);
      }
      return open.call(fs, name, flags, ...rest);
    };
    try { service.readWorkingCopyFile(${JSON.stringify(root)}, 'good.xml'); process.exit(2); }
    catch { process.exit(swapped ? 0 : 3); }
  `], { timeout: 2000, encoding: 'utf8' });
  assert.equal(child.status, 0, `FIFO swap must reject, not block: ${child.error?.code || child.stderr}`);
});

test('repair reader rejects inode replacement between regular-file admission and descriptor open', t => {
  const { root, put } = fixture(t);
  put('swap.xml', '<original/>');
  put('replacement.xml', '<replacement/>');
  const originalOpen = fs.openSync;
  let swapped = false;
  fs.openSync = function(name, ...args) {
    if (!swapped && String(name).endsWith('/swap.xml')) {
      swapped = true;
      fs.renameSync(path.join(root, 'replacement.xml'), path.join(root, 'swap.xml'));
    }
    return originalOpen.call(fs, name, ...args);
  };
  try {
    assert.throws(() => service().readWorkingCopyFile(root, 'swap.xml'), { code: 'FILE_CHANGED', status: 409 });
  } finally { fs.openSync = originalOpen; }
});

test('repair reads admit malformed JSON up to the exact byte ceiling and reject a FIFO', t => {
  const { root, put } = fixture(t);
  const content = '{'.repeat(service().MAX_FILE_BYTES);
  put('limit.json', content);
  const result = service().readWorkingCopyFile(root, 'limit.json');
  assert.equal(result.content, content);
  const fifo = path.join(root, 'pipe.xml');
  require('node:child_process').execFileSync('mkfifo', [fifo]);
  assert.throws(() => service().readWorkingCopyFile(root, 'pipe.xml'), { code: 'INVALID_PATH', status: 400 });
});

test('raw repair reads preserve malformed XML, UTF-8 BOM, and byte hash', t => {
  const { root, put } = fixture(t);
  const bytes = Buffer.from('\ufeff<types>\r\n<type name="broken">é');
  put('db/broken.xml', bytes);
  const result = service().readWorkingCopyFile(root, 'db/broken.xml');
  assert.equal(result.content, bytes.toString('utf8'));
  assert.equal(result.hash, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.fileName, 'db/broken.xml');
  assert.equal(result.filePath, 'db/broken.xml');
  assert.equal(result.parsedData, null);
  assert.equal(result.isLocal, true);
  assert.deepEqual(result.source, {
    kind: 'local_working_copy',
    modifiedAt: fs.statSync(path.join(root, 'db/broken.xml')).mtime.toISOString(),
    providerFreshness: 'unknown',
  });
  assert.ok(!JSON.stringify(result).includes(root));
});
