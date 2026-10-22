'use strict';

const express = require('express');
const { loadConfig } = require('../config');
const { createLogger } = require('../lib/logger');
const { ApiError } = require('../lib/errors');
const { createSupabaseFactory } = require('../lib/supabase');
const { createAuthenticate } = require('../middleware/authenticate');
const { requireRecruit } = require('../middleware/requireRecruit');
const { apiBodyErrorHandler, createApiErrorHandler } = require('../middleware/errorHandlers');
const { createClaudeClient } = require('../services/claudeClient');
const { createInsightsService } = require('../services/insightsService');
const { createToolsService } = require('../services/toolsService');
const { createSupportService } = require('../services/supportService');
const { createEventsService } = require('../services/eventsService');
const { insightsRoutes } = require('./insights');
const { toolsRoutes } = require('./tools');
const { supportRoutes } = require('./support');
const { eventsRoutes } = require('./events');

// Dependencies can be overridden (tests pass fakes for Supabase and Claude).
function buildDeps(overrides = {}) {
  const config = overrides.config || loadConfig();
  const logger = overrides.logger || createLogger();
  return {
    config,
    logger,
    now: overrides.now || (() => new Date()),
    reportError: overrides.reportError || null,
    supabase: overrides.supabase || createSupabaseFactory(config),
    claude: overrides.claude || createClaudeClient({
      apiKey: config.anthropicApiKey,
      model: config.anthropicModel,
      timeoutMs: config.claudeTimeoutMs,
    }),
  };
}

function createApiRouter(overrides = {}) {
  const deps = buildDeps(overrides);
  const authenticate = createAuthenticate(deps);
  const ctx = {
    authenticate,
    requireRecruit,
    insights: createInsightsService(deps),
    tools: createToolsService(deps),
    support: createSupportService(deps),
    events: createEventsService(deps),
  };

  const router = express.Router();
  router.use(insightsRoutes(ctx));
  router.use(toolsRoutes(ctx));
  router.use(supportRoutes(ctx));
  router.use(eventsRoutes(ctx));

  // Unknown /api/* path (the existing /api/signup, /api/login, … are matched
  // by app.js before this router, so they never get here).
  router.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', 'No such endpoint.')));
  router.use(createApiErrorHandler(deps));
  return router;
}

// Mounts the API under /api. Call AFTER the existing routes and BEFORE
// Sentry.setupExpressErrorHandler(app).
function mountApi(app, overrides = {}) {
  app.use('/api', createApiRouter(overrides));
  app.use('/api', apiBodyErrorHandler);
}

module.exports = { mountApi, createApiRouter, buildDeps };
