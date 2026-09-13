/*
 * Approximate real-world DayZ day/night durations using a 12/12 in-game split.
 * Actual daylight varies by in-game season; this is not a sunrise/sunset model.
 * Night acceleration stacks on top of serverTimeAcceleration.
 * Ref: https://community.bistudio.com/wiki/DayZ:Server_Configuration
 */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.DayZTime = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function positiveDecimal(value) {
    if (typeof value === 'string') {
      const text = value.trim();
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
      value = Number(text);
    }
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  }

  function estimate(dayMultiplier, nightMultiplier) {
    dayMultiplier = positiveDecimal(dayMultiplier);
    nightMultiplier = positiveDecimal(nightMultiplier);
    if (dayMultiplier === null || nightMultiplier === null) return null;
    const effectiveNightMultiplier = dayMultiplier * nightMultiplier;
    const dayHours = 12 / dayMultiplier;
    const nightHours = 12 / effectiveNightMultiplier;
    if (![dayHours, nightHours, effectiveNightMultiplier]
      .every(value => Number.isFinite(value) && value > 0)) return null;
    return { dayHours, nightHours, effectiveNightMultiplier };
  }

  return { estimate };
}));
