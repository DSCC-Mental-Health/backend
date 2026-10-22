'use strict';

const { badRequest } = require('./errors');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The request body must be a JSON object containing only the allowed keys.
// Unknown keys are rejected so a client can't slip in e.g. "userId".
function requireObjectBody(body, allowedKeys, { optional = false } = {}) {
  if (body === undefined && optional) return {};
  if (!isPlainObject(body)) {
    throw badRequest('INVALID_BODY', 'Request body must be a JSON object (Content-Type: application/json).');
  }
  const unknown = Object.keys(body).filter((k) => !allowedKeys.includes(k));
  if (unknown.length) {
    throw badRequest('UNKNOWN_FIELD', `Unexpected field: ${unknown[0].slice(0, 40)}.`);
  }
  return body;
}

module.exports = { isPlainObject, requireObjectBody };
