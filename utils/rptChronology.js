'use strict';

function createRptChronology() {
  return { dayOffset: 0, previousMs: null };
}

function parseRptClockTimestamp(timeText, logDate, chronology) {
  const match = String(timeText || '').match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  const dateMatch = String(logDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || !dateMatch) return null;

  const [, yearText, monthText, dayText] = dateMatch;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const dateProbe = new Date(0);
  dateProbe.setUTCFullYear(year, month - 1, day);
  dateProbe.setUTCHours(0, 0, 0, 0);
  if (dateProbe.getUTCFullYear() !== year || dateProbe.getUTCMonth() !== month - 1
      || dateProbe.getUTCDate() !== day) return null;

  const [, hourText, minuteText, secondText, fractionText = ''] = match;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) return null;

  const baseMs = Date.parse(`${logDate}T00:00:00.000Z`);
  if (!Number.isFinite(baseMs)) return null;

  const milliseconds = Number(fractionText.padEnd(3, '0').slice(0, 3));
  let timestampMs = baseMs + chronology.dayOffset * 86400000
    + ((hour * 60 * 60 + minute * 60 + second) * 1000) + milliseconds;
  if (chronology.previousMs !== null && timestampMs + 12 * 60 * 60 * 1000 < chronology.previousMs) {
    chronology.dayOffset += 1;
    timestampMs += 86400000;
  }
  chronology.previousMs = timestampMs;
  return timestampMs;
}

module.exports = { createRptChronology, parseRptClockTimestamp };
