'use strict';

// Calendar-date helpers in Singapore time (UTC+8, no daylight saving).
// Dates are 'YYYY-MM-DD' strings, matching Postgres `date` values.

const SG_TIME_ZONE = 'Asia/Singapore';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SG_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

function sgDateString(instant = new Date()) {
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIsoDate, toIsoDate) {
  return Math.round((Date.parse(`${toIsoDate}T00:00:00Z`) - Date.parse(`${fromIsoDate}T00:00:00Z`)) / 86400000);
}

module.exports = { SG_TIME_ZONE, sgDateString, addDays, daysBetween };
