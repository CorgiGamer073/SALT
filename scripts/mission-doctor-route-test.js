'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const validation = require('../services/validationService');
const router = require('../routes/validation');
const { ensureAuthenticated } = require('../middleware/auth');

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

async function main() {
  const route = router.stack.find(layer => layer.route?.path === '/validate/:fileType').route;
  assert(route.stack.some(layer => layer.handle === ensureAuthenticated), 'draft diagnostics require authentication');
  const handler = route.stack[route.stack.length - 1].handle;
  const original = validation.validateXML;
  const calls = [];
  validation.validateXML = async (...args) => {
    calls.push(args);
    return { valid: true, errors: [], warnings: [], info: [] };
  };
  try {
    for (const body of [{}, { fileName: 'types.xml', content: [] }, { fileName: {}, content: '<types/>' }]) {
      const res = response();
      await handler({ params: { fileType: 'xml' }, body }, res);
      assert.strictEqual(res.statusCode, 400);
    }
    assert.strictEqual(calls.length, 0);
    const res = response();
    await handler({ params: { fileType: 'xml' }, body: {
      fileName: 'custom/loot.xml', content: '<types/>', documentType: 'types.xml',
    } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(calls, [['custom/loot.xml', '<types/>', 'types.xml']]);
    assert.strictEqual(res.body.source, 'submitted_draft');
    assert.strictEqual(res.body.reportOnly, true);
    assert.strictEqual(res.body.providerVerified, false);
    const big = response();
    await handler({ params: { fileType: 'xml' }, body: { fileName: 'types.xml', content: ' '.repeat(5 * 1024 * 1024 + 1) } }, big);
    assert.strictEqual(big.statusCode, 413);
    assert.strictEqual(calls.length, 1);
    const middleware = fs.readFileSync(path.join(__dirname, '../src/app/registerMiddleware.js'), 'utf8');
    assert.match(middleware, /app\.use\('\/api\/validate', ensureAuthenticated, express\.json\(\{ limit: '6mb' \}\)\)/);
    assert(middleware.indexOf("app.use('/api/validate'") < middleware.indexOf('app.use(express.json())'), 'bounded diagnostic parser must precede default 100kb parser');
  } finally {
    validation.validateXML = original;
  }
  console.log('Mission Doctor draft route tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
