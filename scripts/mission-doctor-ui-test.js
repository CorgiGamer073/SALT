'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function harness() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/mission-doctor.js'), 'utf8'), context);
  const button = { disabled: false, listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; } };
  const report = { hidden: true, textContent: '' };
  const source = { textContent: '' };
  const state = { draft: { fileName: 'custom/loot.xml', content: '<types/>', documentType: 'types.xml',
    contextVersion: 1, loadedHash: 'loaded-hash', source: { modifiedAt: '2026-01-01T00:00:00.000Z' } } };
  const requests = [];
  const options = { button, report, source, getDraft: () => state.draft, request: async (...args) => {
    requests.push(args);
    return { ok: true, json: async () => ({ success: true, validation: {
      valid: true, errors: [], warnings: [], info: [], supportLevel: 'basic', sha256: 'draft-hash',
    } }) };
  } };
  const doctor = context.MissionDoctor.create(options);
  return { button, report, source, state, requests, options, doctor };
}

async function testStaleDiagnostics(outcome) {
  const h = harness();
  let finish;
  let reject;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  h.options.request = async () => ({ ok: true, json: () => new Promise((resolve, rejectPromise) => {
    finish = resolve; reject = rejectPromise; signalStarted();
  }) });
  const freshContext = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/mission-doctor.js'), 'utf8'), freshContext);
  const doctor = freshContext.MissionDoctor.create(h.options);
  const running = doctor.inspect();
  await started;
  h.state.draft = { ...h.state.draft, fileName: 'db/events.xml', contextVersion: 2 };
  doctor.invalidate();
  const expected = h.report.textContent;
  if (outcome === 'reject') reject(new Error('Old request failed'));
  else finish({ success: true, validation: { valid: false, errors: [{ message: 'OLD ERROR' }], warnings: [], info: [] } });
  await running;
  assert.strictEqual(h.report.textContent, expected, 'old response must not paint the new file');
  assert.strictEqual(h.report.hidden, true);
  assert.strictEqual(h.button.disabled, false);
}

function editorHarness() {
  const elements = new Map();
  const html = fs.readFileSync(path.join(__dirname, '../public/mission-editor.html'), 'utf8');
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
    elements.set(id, { value: '', disabled: false, textContent: '', hidden: false, style: {},
      classList: { add() {}, remove() {} }, listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; } });
  }
  assert(elements.has('doctorBtn'), 'Mission Editor must expose the report-only Doctor action');
  const requests = [];
  const context = vm.createContext({
    window: { location: { search: '?server=service-a' }, addEventListener() {} }, URLSearchParams,
    navigator: {}, console: { log() {}, error() {} }, alert() {}, confirm: () => true,
    document: { getElementById: id => elements.get(id), querySelectorAll: () => [],
      createElement: () => ({ textContent: '', get innerHTML() {
        return this.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      } }) },
    fetch: async url => ({ json: async () => url.includes('/list/') ? { success: true, files: {} } : {
      success: true, content: '<types/>', hash: 'loaded-hash', documentType: 'types.xml',
      source: { modifiedAt: '2026-01-01T00:00:00.000Z' },
    } }),
    fetchWithCsrf: async (url, options) => {
      requests.push([url, options]);
      return { ok: true, json: async () => url.endsWith('/lock') ? { success: true, lockId: 'lock-a' } : {
        success: true, validation: { valid: true, errors: [], warnings: [], info: [], sha256: 'draft-hash', supportLevel: 'basic' },
      } };
    },
  });
  for (const file of ['mission-doctor.js', 'mission-editor.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'), context);
  }
  return { elements, requests, context };
}

async function testEditorIntegration() {
  const { elements, requests, context } = editorHarness();
  const unsafeName = 'custom/<img src=x onerror=boom>".xml';
  context.unsafeName = unsafeName;
  const rendered = vm.runInContext('renderFileItem(unsafeName, {})', context);
  assert(!rendered.includes('<img'), 'provider file names must not become markup');
  assert(!rendered.includes('>".xml'), 'file-path attributes must escape quotes');
  await vm.runInContext("selectFile('custom/loot.xml')", context);
  assert.strictEqual(elements.get('doctorBtn').disabled, false);
  await elements.get('doctorBtn').listeners.click();
  assert.match(elements.get('doctorReport').textContent, /draft-hash/);
  assert(requests.some(([url]) => url === '/api/validate/xml'));
  assert(!requests.some(([, options]) => options.method === 'PUT'), 'inspection never saves');
  elements.get('editor').value = '<broken>';
  elements.get('editor').listeners.input();
  assert.strictEqual(elements.get('doctorReport').hidden, true, 'typing invalidates old reports');
  context.fetch = async () => ({ json: async () => ({ success: true, files: {}, truncated: true,
    diagnostics: [{ message: 'Discovery limit reached' }] }) });
  await vm.runInContext('loadFileList()', context);
  assert.match(elements.get('fileListStatus').textContent, /incomplete/i);
  assert.match(elements.get('fileListStatus').textContent, /Discovery limit/);
  let finish;
  context.fetch = () => new Promise(resolve => { finish = resolve; });
  const loading = vm.runInContext("selectFile('db/events.xml')", context);
  assert.strictEqual(elements.get('doctorReport').hidden, true);
  assert.strictEqual(elements.get('doctorBtn').disabled, true);
  // Previous lock release precedes the next read.
  for (let turn = 0; !finish && turn < 10; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(typeof finish, 'function', 'file read must start after lock release');
  finish({ json: async () => ({ success: false, error: 'File unavailable' }) });
  await loading;
  assert.strictEqual(elements.get('doctorBtn').disabled, true, 'failed reads cannot inspect the previous file');
  assert.strictEqual(elements.get('editor').value, '');
}

async function testDiscoveredNamesRemainLiteral() {
  const { requests, context } = editorHarness();
  vm.runInContext("fileList = { 'constructor/types.xml': {} }; renderFileTree();", context);
  const reads = [];
  const fetch = context.fetch;
  context.fetch = async url => { reads.push(url); return fetch(url); };
  await vm.runInContext("selectFile('custom/what#file?.xml')", context);
  assert.ok(reads.some(url => url.endsWith('/custom/what%23file%3F.xml')));
  assert.ok(requests.some(([url]) => url.endsWith('/custom/what%23file%3F.xml/lock')));
}

async function testEditorSaveContextIsStable() {
  const { elements, context } = editorHarness();
  await vm.runInContext("selectFile('custom/loot.xml')", context);
  let finish;
  context.fetchWithCsrf = () => new Promise(resolve => { finish = resolve; });
  vm.runInContext("conflictServerHash = 'new-hash'", context);
  const saving = vm.runInContext("resolveConflict('overwrite')", context);
  assert.strictEqual(elements.get('editor').disabled, true, 'pending overwrite must lock the draft');
  assert.strictEqual(elements.get('doctorBtn').disabled, true);
  assert.strictEqual(elements.get('releaseLockBtn').disabled, true, 'lock release must not interrupt a pending file save');
  await vm.runInContext("selectFile('db/events.xml')", context);
  assert.strictEqual(vm.runInContext('currentFile', context), 'custom/loot.xml');
  finish({ json: async () => ({ success: true, hash: 'saved-hash' }) });
  await saving;
  assert.strictEqual(elements.get('editor').disabled, false);
}

async function main() {
  await testDiscoveredNamesRemainLiteral();
  await testEditorSaveContextIsStable();
  await testEditorIntegration();
  await testStaleDiagnostics('resolve');
  await testStaleDiagnostics('reject');
  const h = harness();
  await h.button.listeners.click();
  assert.strictEqual(h.requests.length, 1);
  assert.strictEqual(h.requests[0][0], '/api/validate/xml');
  assert.deepStrictEqual(JSON.parse(h.requests[0][1].body), {
    fileName: 'custom/loot.xml', content: '<types/>', documentType: 'types.xml',
  });
  assert.match(h.report.textContent, /report.only/i);
  assert.match(h.report.textContent, /draft-hash/);
  assert.match(h.source.textContent, /local working copy/i);
  assert.match(h.source.textContent, /unknown/i);
  assert.strictEqual(h.state.draft.content, '<types/>');
  assert.strictEqual(h.report.hidden, false);
  console.log('Mission Doctor UI tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
