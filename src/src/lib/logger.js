'use strict';

// Tiny structured logger. It only accepts an event name plus primitive fields,
// so request bodies, journal text, handoff reasons and tokens can't be logged
// by accident (callers never pass them, and objects are dropped).

function cleanFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = typeof value === 'string' ? value.slice(0, 120) : value;
    }
  }
  return out;
}

function createLogger(sink = console) {
  const write = (level) => (event, fields) =>
    sink[level](JSON.stringify({ level, event, ...cleanFields(fields) }));
  return { info: write('info'), warn: write('warn'), error: write('error') };
}

module.exports = { createLogger };
