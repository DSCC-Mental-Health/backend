'use strict';

// Every error from the new API routes is sent as:
//   { "error": { "code": "SOME_CODE", "message": "Human readable." } }

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const badRequest = (code, message) => new ApiError(400, code, message);
const notFound = (code, message) => new ApiError(404, code, message);
const forbidden = (code, message) => new ApiError(403, code, message);

// A database call failed unexpectedly. Only the Postgres/PostgREST error code
// is logged — never the message, which can echo user data.
function databaseError(what, error, logger) {
  if (logger) logger.error('database_error', { what, pgCode: error && error.code });
  return new ApiError(500, 'DATABASE_ERROR', `Could not ${what}.`);
}

module.exports = { ApiError, badRequest, notFound, forbidden, databaseError };
