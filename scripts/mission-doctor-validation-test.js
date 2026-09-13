'use strict';

// Synthetic configuration contracts only; no external mission library or providers.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const validation = require('../services/validationService');
const xml = body => '<?xml version="1.0" encoding="UTF-8"?>\n' + body;

const contracts = [
  ['events.xml', '<events><event name="Dormant"><nominal>0</nominal><active>0</active></event></events>'],
  ['cfgeventspawns.xml', '<eventposdef><event name="Vehicle"><pos x="0" z="0"/></event></eventposdef>'],
  ['cfgenvironment.xml', '<env><territories><file path="env/test.xml"/></territories></env>'],
  ['cfgweather.xml', '<weather enable="0"><overcast><current actual="0"/></overcast></weather>'],
  ['cfgspawnabletypes.xml', '<spawnabletypes><type name="Test"><hoarder/></type></spawnabletypes>'],
  ['mapgroupproto.xml', '<prototype><defaults/><group name="Test"><container name="lootFloor"/></group></prototype>'],
  ['cfgplayerspawnpoints.xml', '<playerspawnpoints><fresh/><hop/></playerspawnpoints>'],
  ['cfgrandompresets.xml', '<randompresets><attachments name="Test" chance="0"><item name="Item" chance="1"/></attachments></randompresets>']
];

test('dispatch uses exact canonical basenames or a recognized explicit type, never root inference', async () => {
  for (const fileName of ['types.xml', '/mission/db/types.xml', 'C:\\mission\\db\\types.xml']) {
    const result = await validation.validateXML(fileName, xml('<wrong/>'));
    assert.equal(result.valid, false, fileName);
    assert.equal(result.documentType, 'types.xml');
    assert.equal(result.supportLevel, 'basic');
  }
  for (const fileName of ['custom.xml', 'custom-types.xml', 'TYPES.XML', ' types.xml', 'types.xml.bak', 'constructor', '__proto__', 'types.xml/']) {
    const result = await validation.validateXML(fileName, xml('<types><type/></types>'));
    assert.equal(result.valid, true, fileName);
    assert.equal(result.documentType, null);
    assert.equal(result.supportLevel, 'syntax-only');
  }
  const explicit = await validation.validateXML('custom.xml', xml('<wrong/>'), 'types.xml');
  assert.equal(explicit.valid, false);
  assert.equal(explicit.documentType, 'types.xml');
  const override = await validation.validateXML('types.xml', xml('<events><event name="Test"/></events>'), 'events.xml');
  assert.equal(override.valid, true);
  assert.equal(override.documentType, 'events.xml');
  for (const documentType of ['unsupported', 'constructor', '__proto__', '../types.xml', {}, 'TYPES.XML']) {
    const result = await validation.validateXML('custom.xml', xml('<types><type/></types>'), documentType);
    assert.equal(result.supportLevel, 'syntax-only');
    assert.equal(result.valid, true);
  }
});

test('types numbers are complete finite CHILD values, not inferred attributes or classes', async () => {
  for (const field of ['nominal', 'lifetime', 'restock', 'min', 'quantmin', 'quantmax', 'cost']) {
    for (const value of ['1junk', 'NaN', 'Infinity', '1e9999', '', ' ', '0x10', '<nested>1</nested>', '1<extra/>']) {
      const report = await validation.validateXML('types.xml', xml(`<types><type name="Test"><${field}>${value}</${field}></type></types>`));
      assert.equal(report.valid, false, `${field}=${value}`);
      assert(report.errors.some(error => error.code === 'INVALID_NUMBER'), `${field}=${value}`);
    }
  }
  for (const value of ['0', '12', '1.5', '.5', '1e2', ' 2 ']) {
    const report = await validation.validateXML('types.xml', xml(`<types><type name="Modded-Unknown"><nominal>${value}</nominal></type></types>`));
    assert.equal(report.valid, true);
    assert(!report.warnings.some(warning => warning.code === 'INVALID_NAME_FORMAT'));
  }
  const dormant = await validation.validateXML('types.xml', xml('<types><type name="Dormant"><nominal>0</nominal><min>0</min><lifetime>0</lifetime><restock>0</restock><cost>0</cost><quantmin>-1</quantmin><quantmax>-1</quantmax></type></types>'));
  assert.equal(dormant.valid, true);
  assert.deepEqual(dormant.warnings.filter(w => ['NEGATIVE_VALUE', 'MIN_GREATER_THAN_NOMINAL', 'QUANTMIN_GREATER_THAN_QUANTMAX'].includes(w.code)), []);
  const wrongAttribute = await validation.validateXML('types.xml', xml('<types><type name="Test" nominal="not-a-child"/></types>'));
  assert.equal(wrongAttribute.valid, true);
  const warning = await validation.validateXML('types.xml', xml('<types><type name="Test"><nominal>1</nominal><min>2</min><quantmin>4</quantmin><quantmax>2</quantmax><cost>-2</cost></type></types>'));
  for (const code of ['NEGATIVE_VALUE', 'MIN_GREATER_THAN_NOMINAL', 'QUANTMIN_GREATER_THAN_QUANTMAX']) assert(warning.warnings.some(w => w.code === code), code);
});

test('recognized named entries require nonblank names even without any attributes', async () => {
  const missingNames = [
    ['types.xml', '<types><type/></types>'],
    ['types.xml', '<types><type name="  "/></types>'],
    ['events.xml', '<events><event/></events>'],
    ['cfgeventspawns.xml', '<eventposdef><event><pos x="1" z="1"/></event></eventposdef>'],
    ['cfgspawnabletypes.xml', '<spawnabletypes><type/></spawnabletypes>'],
    ['mapgroupproto.xml', '<prototype><group/></prototype>'],
    ['mapgroupproto.xml', '<prototype><group name="Test"><container/></group></prototype>'],
    ['cfgrandompresets.xml', '<randompresets><cargo chance="0"/></randompresets>'],
    ['cfgrandompresets.xml', '<randompresets><attachments/></randompresets>'],
    ['cfgrandompresets.xml', '<randompresets><cargo name="Test"><item/></cargo></randompresets>'],
    ['cfgrandompresets.xml', '<randompresets><attachments name="Test"><item/></attachments></randompresets>'],
    ['globals.xml', '<variables><var/></variables>']
  ];
  for (const [fileName, body] of missingNames) {
    const result = await validation.validateXML(fileName, xml(body));
    assert.equal(result.valid, false, body);
    assert(result.errors.some(error => error.code === 'MISSING_ATTRIBUTE' && error.attribute === 'name'), body);
  }
});

test('empty registries and cargo-only or attachment-only presets do not require invented children', async () => {
  for (const [fileName, root] of [
    ['types.xml', 'types'], ['events.xml', 'events'], ['cfgeventspawns.xml', 'eventposdef'],
    ['cfgspawnabletypes.xml', 'spawnabletypes'], ['mapgroupproto.xml', 'prototype'],
    ['cfgrandompresets.xml', 'randompresets'], ['messages.xml', 'messages']
  ]) {
    const result = await validation.validateXML(fileName, xml(`<${root}/>`));
    assert.equal(result.valid, true, fileName);
  }
  for (const kind of ['cargo', 'attachments']) {
    const result = await validation.validateXML('cfgrandompresets.xml', xml(`<randompresets><${kind} name="Test" chance="0"><item name="Unknown_Class" chance="0"/></${kind}></randompresets>`));
    assert.equal(result.valid, true);
    assert.deepEqual(result.warnings, []);
  }
});

test('XML reports hash exact input on success, empty input and syntax failures without parsed trees', async () => {
  const { createHash } = require('node:crypto');
  for (const content of [xml('<types/>'), '\uFEFF' + xml('<types/>') + '\r\n', '', '  ', '<types><type></types>']) {
    const report = await validation.validateXML('types.xml', content);
    assert.equal(report.sha256, createHash('sha256').update(content, 'utf8').digest('hex'));
    assert.equal(report.inputBytes, Buffer.byteLength(content, 'utf8'));
    assert.equal(report.documentType, 'types.xml');
    assert.equal(report.supportLevel, 'basic');
    assert(!Object.hasOwn(report, 'structure'));
    assert(!Object.hasOwn(report, 'parsed'));
    assert.equal(report.limits.maxInputBytes, 5 * 1024 * 1024);
  }
});

test('input budget is UTF-8 bytes, checked before XML or JSON parsing, with structured input errors', async () => {
  const max = 5 * 1024 * 1024;
  const exact = '<x>' + ' '.repeat(max - 7) + '</x>';
  assert.equal((await validation.validateXML('custom.xml', exact)).valid, true);
  for (const content of [exact + ' ', '<x>' + 'é'.repeat(max / 2) + '</x>']) {
    for (const method of ['validateXML', 'validateJSON']) {
      const report = await validation[method]('custom', content);
      assert.equal(report.valid, false);
      assert.equal(report.errors[0].code, 'INPUT_TOO_LARGE');
      assert.equal(report.inputBytes, Buffer.byteLength(content));
      assert.equal(report.sha256.length, 64);
    }
  }
  for (const content of [null, undefined, 0, {}, [], Buffer.from('<x/>')]) {
    for (const method of ['validateXML', 'validateJSON']) {
      const report = await validation[method]('custom', content);
      assert.equal(report.valid, false);
      assert.equal(report.errors[0].code, 'INVALID_CONTENT');
      assert.equal(report.sha256, null);
      assert.equal(report.inputBytes, null);
    }
  }
});

test('JSON remains synchronous syntax-only with stable summaries and no raw parsed payload', () => {
  const { createHash } = require('node:crypto');
  for (const content of ['{"version":1}', 'null', '[]', '{', '']) {
    const result = validation.validateJSON('cfggameplay.json', content);
    assert.equal(typeof result.then, 'undefined');
    assert.equal(result.valid, !['{', ''].includes(content));
    assert.equal(result.supportLevel, 'syntax-only');
    assert.equal(result.documentType, null);
    assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'));
    assert(!Object.hasOwn(result, 'parsed'));
    assert.deepEqual(validation.getValidationSummary(result), {
      valid: result.valid, errorCount: result.errors.length, warningCount: result.warnings.length,
      infoCount: result.info.length, status: result.valid ? (result.warnings.length ? 'good' : 'excellent') : 'invalid'
    });
  }
});

test('diagnostic collections stop at 100 entries but keep exact omission totals on every return path', async () => {
  const content = xml('<types>\n' + '<type><cost>-2</cost></type>\n'.repeat(105) + '</types>');
  const result = await validation.validateXML('types.xml', content);
  assert.equal(result.valid, false);
  for (const kind of ['errors', 'warnings']) {
    assert.equal(result[kind].length, 100);
    assert.deepEqual(result.truncation[kind], { total: 105, omitted: 5, truncated: true });
  }
  assert.equal(result.limits.maxDiagnostics, 100);
  for (const report of [result, await validation.validateXML('custom.xml', ''), await validation.validateXML('custom.xml', '<bad>'), validation.validateJSON('custom.json', '{}'), validation.validateJSON('custom.json', null)]) {
    for (const kind of ['errors', 'warnings', 'info']) {
      assert(report[kind].length <= 100);
      assert.equal(report.truncation[kind].total, report[kind].length + report.truncation[kind].omitted);
      assert.equal(report.truncation[kind].truncated, report.truncation[kind].omitted > 0);
    }
  }
});

test('diagnostic text cannot echo a giant input name or parser error', async () => {
  const hugeName = 'a'.repeat(50000);
  for (const report of [
    await validation.validateXML('types.xml', xml(`<${hugeName}/>`)),
    await validation.validateXML('custom.xml', `<${hugeName}></wrong>`)
  ]) {
    assert.equal(report.valid, false);
    assert(report.errors.length > 0);
    for (const kind of ['errors', 'warnings', 'info']) {
      for (const diagnostic of report[kind]) assert(diagnostic.message.length <= 512);
    }
    assert(JSON.stringify(report).length < 5000);
  }
});

test('XML syntax checks the entire document, including content after a self-closing root', async () => {
  for (const content of ['<a/><b/>', '<a/>text', '<a></a><b/>', '<a/><!-- unfinished', '<a enabled/>', '<a><b></a>', '<!DOCTYPE a [<!ENTITY ex SYSTEM "file:///nonexistent">]><a>&ex;</a>']) {
    const report = await validation.validateXML('custom.xml', content);
    assert.equal(report.valid, false, content);
    assert(!report.info.some(item => item.code === 'SYNTAX_OK'), content);
  }
  for (const content of ['<a/><!-- after root -->', '<?xml version="1.0"?><a><b/><![CDATA[<x/>]]></a>', '\uFEFF<a/>\r\n']) {
    assert.equal((await validation.validateXML('custom.xml', content)).valid, true, content);
  }
});

test('event spawn positions require complete finite coordinates without guessing map bounds', async () => {
  for (const value of ['1junk', 'NaN', 'Infinity', '1e999', ' ', '0x10']) {
    const report = await validation.validateXML('cfgeventspawns.xml', xml(`<eventposdef><event name="Test"><pos x="${value}" z="0"/></event></eventposdef>`));
    assert.equal(report.valid, false, value);
    assert(report.errors.some(item => item.code === 'INVALID_COORDINATES'), value);
  }
  const missing = await validation.validateXML('cfgeventspawns.xml', xml('<eventposdef><event name="Test"><pos x="0"/></event></eventposdef>'));
  assert(missing.errors.some(item => item.code === 'MISSING_COORDINATES'));
  const largeMap = await validation.validateXML('cfgeventspawns.xml', xml('<eventposdef><event name="Test"><pos x="20000" z="0"/></event></eventposdef>'));
  assert.equal(largeMap.valid, true);
  assert.deepEqual(largeMap.warnings, []);
  const definition = await validation.validateXML('events.xml', xml('<events><event name="Test"><pos x="unknown-extension"/></event></events>'));
  assert.equal(definition.valid, true, 'position validation is only for cfgeventspawns.xml');
});

test('zero nominal entries may retain positive minimums without a dormant-template warning', async () => {
  const report = await validation.validateXML('types.xml', xml('<types><type name="Dormant"><nominal>0</nominal><min>1</min><quantmin>-1</quantmin><quantmax>-1</quantmax></type></types>'));
  assert.equal(report.valid, true);
  assert.deepEqual(report.warnings, []);
});

test('large valid JSON within the byte limit does not overflow indentation argument limits', () => {
  const content = '[\n' + '  0,\n'.repeat(200000) + '  0\n]';
  const report = validation.validateJSON('custom.json', content);
  assert.equal(report.valid, true);
  assert(report.info.some(item => item.code === 'INDENTATION_STYLE' && item.message.includes('2-space')));
});

test('map position group entries require their declared name attribute', async () => {
  const report = await validation.validateXML('mapgrouppos.xml', xml('<map><group pos="0 0 0"/></map>'));
  assert.equal(report.valid, false);
  assert(report.errors.some(item => item.code === 'MISSING_ATTRIBUTE' && item.attribute === 'name'));
});

// Characterization coverage: legacy lint remains an explicitly separate operation.
// No lint implementation change is needed or intended by these tests.
test('legacy XML lint formats but does not repair or gate invalid numeric settings', async () => {
  const content = '<types><type name="Test"><nominal>bad</nominal></type></types>  ';
  const report = await validation.validateXML('types.xml', content);
  assert.equal(report.valid, false);
  assert(!Object.hasOwn(report, 'fixed'));
  const lint = await validation.lintAndFix('types.xml', content, 'xml');
  assert.deepEqual(lint, {
    fixed: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<types>\n  <type name="Test">\n    <nominal>bad</nominal>\n  </type>\n</types>',
    fixes: [
      { message: 'Added XML declaration', code: 'ADD_XML_DECLARATION' },
      { message: 'Removed trailing whitespace', code: 'REMOVE_TRAILING_WHITESPACE' },
      { message: 'Reformatted XML for consistency', code: 'REFORMAT_XML' }
    ],
    hasChanges: true
  });
});

test('legacy JSON lint retains its formatting result and invalid-input fallback', async () => {
  assert.deepEqual(await validation.lintAndFix('custom.json', '{"a":1}', 'json'), {
    fixed: '{\n  "a": 1\n}\n',
    fixes: [{ message: 'Reformatted JSON with 2-space indentation', code: 'REFORMAT_JSON' }],
    hasChanges: true
  });
  const invalid = await validation.lintAndFix('custom.json', '{', 'json');
  assert.equal(invalid.fixed, '{');
  assert.equal(invalid.hasChanges, false);
  assert.equal(typeof invalid.error, 'string');
  assert.deepEqual(invalid.fixes, []);
  assert.deepEqual(await validation.lintAndFix('custom', 'unchanged', 'other'), { fixed: 'unchanged', fixes: [], hasChanges: false });
});

for (const [fileName, body] of contracts) {
  test(`${fileName} accepts its real vanilla root and rejects a wrong root`, async () => {
    const result = await validation.validateXML(fileName, xml(body));
    assert.equal(result.valid, true, `${fileName}: ${JSON.stringify(result.errors)}`);
    const wrong = await validation.validateXML(fileName, xml('<incorrect/>'));
    assert.equal(wrong.valid, false, fileName);
    assert(wrong.errors.some(error => error.code === 'WRONG_ROOT'), fileName);
  });
}
