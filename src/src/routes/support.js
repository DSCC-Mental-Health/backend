'use strict';

const express = require('express');

function supportRoutes({ authenticate, requireRecruit, support }) {
  const router = express.Router();

  // Any signed-in user (recruit, commander or not yet enrolled).
  router.get('/support/resources', authenticate, async (req, res) => {
    res.json(await support.listResources(req));
  });

  // Recruits only. Returns 403 FEATURE_DISABLED until professional sign-off.
  router.post('/support/handoff', authenticate, requireRecruit, async (req, res) => {
    res.status(201).json(await support.requestHandoff(req));
  });

  return router;
}

module.exports = { supportRoutes };
