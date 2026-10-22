'use strict';

const { ApiError } = require('../lib/errors');

// Body-parser errors (bad JSON, body too large) for /api routes.
// Everything else is passed on untouched.
function bodyParserError(err) {
  if (err && err.type === 'entity.parse.failed') return new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  if (err && err.type === 'entity.too.large') return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  return null;
}

function sendApiError(res, err) {
  res.status(err.status).json({ error: { code: err.code, message: err.message } });
}

// Mounted at app level on '/api' BEFORE Sentry's handler: turns malformed JSON
// into a 400 instead of the generic 500. Leaves all other errors alone, so the
// existing /api/signup etc. behave exactly as before.
function apiBodyErrorHandler(err, req, res, next) {
  const mapped = bodyParserError(err);
  if (!mapped || res.headersSent) return next(err);
  return sendApiError(res, mapped);
}

// Final error handler for the new API router.
// Unexpected errors are reported to Sentry and answered with a generic 500.
// Nothing from the request (body, headers, token) is logged.
function createApiErrorHandler({ logger, reportError }) {
  // eslint-disable-next-line no-unused-vars
  return function apiErrorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);
    if (err instanceof ApiError) return sendApiError(res, err);
    const mapped = bodyParserError(err);
    if (mapped) return sendApiError(res, mapped);

    let errorId;
    try {
      errorId = reportError ? reportError(err) : undefined;
    } catch {
      errorId = undefined;
    }
    logger.error('unhandled_error', { name: err && err.name, errorId: errorId || null });
    return res.status(500).json({
      error: { code: 'INTERNAL', message: 'Something went wrong.', ...(errorId ? { errorId } : {}) },
    });
  };
}

module.exports = { apiBodyErrorHandler, createApiErrorHandler };
