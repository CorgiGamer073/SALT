#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

test('browser script exposes only DayZTime.estimate without CommonJS or DOM dependencies', () => {
  const browser = vm.createContext({});
  vm.runInContext(fs.readFileSync(modulePath, 'utf8'), browser);
  assert.deepEqual(Object.keys(browser), ['DayZTime']);
  assert.deepEqual(Object.keys(browser.DayZTime), ['estimate']);
  assert.deepEqual(JSON.parse(JSON.stringify(browser.DayZTime.estimate(2, 4))), {
    dayHours: 6, nightHours: 1.5, effectiveNightMultiplier: 8,
  });
});

const modulePath = path.join(__dirname, '..', 'public', 'js', 'dayz-time.js');

test('estimator accepts complete decimal strings without coercing invalid values', () => {
  const { estimate } = require(modulePath);
  for (const value of ['2', ' 2.0 ', '+2', '02', '2.', '2e0', '20E-1']) {
    assert.deepEqual(estimate(value, '4'), {
      dayHours: 6, nightHours: 1.5, effectiveNightMultiplier: 8,
    });
  }
  assert.deepEqual(estimate('.5', '2'), {
    dayHours: 24, nightHours: 12, effectiveNightMultiplier: 1,
  });
  const invalid = [
    undefined, null, '', '  \t\n', true, false, [], [2], {},
    { valueOf() { throw new Error('must not coerce objects'); } },
    Symbol('2'), 2n, new Number(2), 0, -0, -2, NaN, Infinity, -Infinity,
    '0', '-0', '-2', 'NaN', 'Infinity', '2x', '2 hours', '2 4', '2\n4',
    '0x10', '0b10', '0o10', '1_000', '.', '+', '2e', '1e309', '1e-999',
  ];
  for (const value of invalid) {
    assert.equal(estimate(value, 4), null, `invalid day type: ${typeof value}`);
    assert.equal(estimate(2, value), null, `invalid night type: ${typeof value}`);
  }
  assert.equal(estimate(), null);
});

test('estimator rejects arithmetic overflow or underflow instead of nonpositive/nonfinite outputs', () => {
  const { estimate } = require(modulePath);
  for (const [day, night] of [
    [Number.MAX_VALUE, 2], // stacked multiplier overflows
    [1e-200, 1e-200], // stacked multiplier underflows to zero
    [Number.MIN_VALUE, 1], // day duration overflows
    [1, Number.MIN_VALUE], // night duration overflows
    ['1e308', '2'],
    ['1e-200', '1e-200'],
  ]) {
    assert.equal(estimate(day, night), null, `unsafe arithmetic for ${day}, ${night}`);
  }
  for (const [day, night] of [[Number.MAX_VALUE, 1], [1, Number.MAX_VALUE], [0.5, 0.5]]) {
    const result = estimate(day, night);
    assert.ok(result, 'representable positive durations remain valid');
    assert.ok(Object.values(result).every(value => Number.isFinite(value) && value > 0));
  }
});

test('bot image includes the shared estimator at the required absolute path', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile.bot'), 'utf8');
  assert.match(dockerfile, /^COPY public\/js\/dayz-time\.js \/app\/public\/js\/dayz-time\.js\s*$/m,
    'standalone bot image must include the shared browser/CommonJS estimator');
});

test('CommonJS estimator stacks night speed using the approximate 12/12 split', () => {
  assert.ok(fs.existsSync(modulePath), 'shared DayZ time module must exist');
  const api = require(modulePath);
  assert.deepEqual(Object.keys(api), ['estimate']);
  assert.deepEqual(api.estimate(2, 4), {
    dayHours: 6, nightHours: 1.5, effectiveNightMultiplier: 8,
  });
  assert.deepEqual(api.estimate(1, 1), {
    dayHours: 12, nightHours: 12, effectiveNightMultiplier: 1,
  });
});
